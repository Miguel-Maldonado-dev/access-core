import "server-only";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isPlatformAdmin, requireTenantRole, requireUser, type TenantRole } from "@/lib/auth/guards";
import { parsePassword } from "@/lib/auth/session";
import { parseEmail } from "@/lib/email";
import { HttpError } from "@/lib/errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Miembros de un tenant (`/t/[tenant]/users`, solo `admin`) como el usuario de la sesión.
 * Las lecturas y escrituras de `tenant_members` van con el cliente de la sesión (RLS); la
 * llave secreta solo se usa, tras comprobar el rol, para leer correos de Auth y crear cuentas.
 * La regla "al menos un administrador" la hace cumplir la base (trigger de la migración
 * tenant_admin_guard); aquí solo se traduce su error a un 409.
 */

export const LAST_ADMIN_MESSAGE = "El tenant debe tener al menos un administrador.";
const YA_ES_MIEMBRO = "Ese correo ya es miembro del tenant.";
export const PENDING_ELSEWHERE_MESSAGE =
  "Ese correo tiene una cuenta pendiente en otra organización. Pide al súper administrador que la active.";
const NO_ES_MIEMBRO = "Ese usuario no es miembro del tenant.";
const esUuid = (s: string) => z.guid().safeParse(s).success;

export interface TenantMember {
  userId: string;
  email: string;
  role: TenantRole;
}

export interface UserEmail {
  email: string;
  confirmed: boolean;
}

/** `existingAccount`: el correo ya tenía una cuenta confirmada y conserva su contraseña. */
export interface AccountResult {
  existingAccount: boolean;
}

/** `self`: el cambio fue sobre el propio usuario (puede haber perdido el acceso). */
export interface MemberChange {
  self: boolean;
}

/** Correo y confirmación de los usuarios de Auth pedidos (llave secreta). */
export async function fetchUserEmails(userIds: string[]): Promise<Map<string, UserEmail>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await createAdminSupabase().rpc("auth_user_emails", { p_user_ids: userIds });
  if (error) throw error;
  const filas = data as { user_id: string; email: string; email_confirmed: boolean }[];
  return new Map(filas.map((f) => [f.user_id, { email: f.email, confirmed: f.email_confirmed }]));
}

async function buscarUsuario(admin: SupabaseClient, email: string): Promise<string | null> {
  const { data, error } = await admin.rpc("auth_user_id_by_email", { p_email: email });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** Cuenta de Auth lista para dar de alta; `created` solo si esta llamada la creó. */
interface Cuenta {
  userId: string;
  created: boolean;
  /** Ya estaba confirmada: se conserva su contraseña. */
  existing: boolean;
}

/**
 * Obtiene la cuenta de Auth de ese correo, sin enviar ningún correo:
 *  - sin cuenta: se crea ya confirmada, con la contraseña dada;
 *  - con cuenta confirmada: se reutiliza y su contraseña no cambia;
 *  - con cuenta sin confirmar (invitación pendiente anterior): se le pone la contraseña dada
 *    y se confirma, pero solo si quien da de alta es súper administrador o la cuenta no es
 *    miembro de ningún tenant ni súper administradora. Si no, 409 sin cambiar nada: de otro modo un admin del tenant A
 *    podría fijar la contraseña de alguien con invitación pendiente en el tenant B y entrar a B.
 * La contraseña nunca se registra ni se devuelve.
 */
async function obtenerCuenta(
  admin: SupabaseClient,
  email: string,
  password: string,
  esSuperAdmin: boolean,
): Promise<Cuenta> {
  let userId = await buscarUsuario(admin, email);
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (!error) return { userId: data.user.id, created: true, existing: false };
    if (error.code === "weak_password") {
      throw new HttpError(400, "La contraseña es muy débil: usa letras, números y símbolos.");
    }
    if (error.code !== "email_exists") throw error;
    // La cuenta se creó entre la búsqueda y el alta: se trata como cuenta existente.
    userId = await buscarUsuario(admin, email);
    if (!userId) throw error;
  }

  if ((await fetchUserEmails([userId])).get(userId)?.confirmed) {
    return { userId, created: false, existing: true };
  }
  if (!esSuperAdmin) {
    // Con la llave secreta (salta RLS): interesan las membresías de todos los tenants.
    const { data: membresias, error: errorMembresias } = await admin
      .from("tenant_members")
      .select("tenant_id")
      .eq("user_id", userId)
      .limit(1);
    if (errorMembresias) throw errorMembresias;
    // Tampoco una cuenta pendiente de súper administrador: pondría su contraseña y entraría como tal.
    if (membresias.length > 0 || (await isPlatformAdmin(userId))) {
      throw new HttpError(409, PENDING_ELSEWHERE_MESSAGE);
    }
  }
  const { error } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
  if (error?.code === "weak_password") {
    throw new HttpError(400, "La contraseña es muy débil: usa letras, números y símbolos.");
  }
  if (error) throw error;
  return { userId, created: false, existing: false };
}

/**
 * Da de alta en el tenant, con el rol dado, a la persona con ese correo y crea su cuenta si
 * hace falta (ver `obtenerCuenta`): nunca se envía una invitación. La membresía se inserta
 * con el cliente de la sesión, así que la RLS exige otra vez admin del tenant o súper
 * administrador. Si la membresía falla, se borra la cuenta que esta llamada creó (una cuenta
 * sin confirmar que se adoptó queda confirmada sin tenant: no da acceso a nada). Quien llama
 * ya validó el correo y la contraseña, comprobó el rol y dice si es súper administrador
 * (`esSuperAdmin`), que es lo que permite adoptar cuentas pendientes de otro tenant.
 */
export async function addMemberWithAccount(
  supabase: SupabaseClient,
  tenantId: string,
  email: string,
  password: string,
  role: TenantRole,
  esSuperAdmin: boolean,
): Promise<AccountResult> {
  const admin = createAdminSupabase();
  const cuenta = await obtenerCuenta(admin, email, password, esSuperAdmin);

  const { error } = await supabase
    .from("tenant_members")
    .insert({ tenant_id: tenantId, user_id: cuenta.userId, role });
  if (error) {
    if (cuenta.created) {
      const { error: errorBorrado } = await admin.auth.admin.deleteUser(cuenta.userId);
      if (errorBorrado) throw errorBorrado;
    }
    if (error.code === "23505") throw new HttpError(409, YA_ES_MIEMBRO);
    throw error;
  }
  return { existingAccount: cuenta.existing };
}

/** El trigger de último administrador → 409 con su mensaje; los demás errores siguen. */
function traducirError(error: PostgrestError | null): void {
  if (!error) return;
  if (error.code === "23514" && error.message === LAST_ADMIN_MESSAGE) {
    throw new HttpError(409, LAST_ADMIN_MESSAGE);
  }
  throw error;
}

/** Miembros del tenant con su correo y su rol, ordenados por correo (solo `admin`). */
export async function listMembersAs(supabase: SupabaseClient, tenantId: string): Promise<TenantMember[]> {
  const { supabase: cliente } = await requireTenantRole(tenantId, "admin", supabase);
  const { data, error } = await cliente
    .from("tenant_members")
    .select("user_id, role")
    .eq("tenant_id", tenantId)
    .overrideTypes<{ user_id: string; role: TenantRole }[], { merge: false }>();
  if (error) throw error;

  const correos = await fetchUserEmails(data.map((m) => m.user_id));
  return data
    .map((m) => ({
      userId: m.user_id,
      email: correos.get(m.user_id)?.email ?? "",
      role: m.role,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Da de alta a un miembro del tenant con su cuenta, sin invitación (solo `admin`). */
export async function addMemberAs(
  supabase: SupabaseClient,
  tenantId: string,
  email: string,
  password: string,
  role: TenantRole,
): Promise<AccountResult> {
  const acceso = await requireTenantRole(tenantId, "admin", supabase);
  return addMemberWithAccount(
    acceso.supabase,
    tenantId,
    parseEmail(email),
    parsePassword(password),
    role,
    await isPlatformAdmin(acceso.userId),
  );
}

/** Cambia el rol de un miembro (solo `admin`). Degradar al último admin da 409. */
export async function changeMemberRoleAs(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  role: TenantRole,
): Promise<MemberChange> {
  const acceso = await requireTenantRole(tenantId, "admin", supabase);
  if (!esUuid(userId)) throw new HttpError(404, NO_ES_MIEMBRO);

  const { data, error } = await acceso.supabase
    .from("tenant_members")
    .update({ role })
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .select("user_id")
    .maybeSingle();
  traducirError(error);
  if (!data) throw new HttpError(404, NO_ES_MIEMBRO);
  return { self: userId === acceso.userId };
}

/** Quita a un miembro del tenant (solo `admin`). Quitar al último admin da 409. */
export async function removeMemberAs(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<MemberChange> {
  const acceso = await requireTenantRole(tenantId, "admin", supabase);
  if (!esUuid(userId)) throw new HttpError(404, NO_ES_MIEMBRO);

  const { data, error } = await acceso.supabase
    .from("tenant_members")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .select("user_id")
    .maybeSingle();
  traducirError(error);
  if (!data) throw new HttpError(404, NO_ES_MIEMBRO);
  return { self: userId === acceso.userId };
}

/** Tenant del que el usuario de la sesión es miembro (para el inicio). */
export interface MyTenant {
  id: string;
  name: string;
  role: TenantRole;
  suspended: boolean;
}

/**
 * Tenants del usuario de la sesión con su rol, ordenados por nombre. Por RLS, quien no es
 * súper administrador solo ve los activos; el súper administrador ve también los suspendidos.
 */
export async function listMyTenantsAs(supabase: SupabaseClient): Promise<MyTenant[]> {
  const { userId, supabase: cliente } = await requireUser(supabase);
  const { data, error } = await cliente
    .from("tenant_members")
    .select("role, tenants(id, name, suspended_at)")
    .eq("user_id", userId)
    .overrideTypes<
      { role: TenantRole; tenants: { id: string; name: string; suspended_at: string | null } | null }[],
      { merge: false }
    >();
  if (error) throw error;
  return data
    .flatMap((m) =>
      m.tenants
        ? [{ id: m.tenants.id, name: m.tenants.name, role: m.role, suspended: m.tenants.suspended_at !== null }]
        : [],
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
