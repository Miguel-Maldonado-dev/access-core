import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { parsePassword } from "@/lib/auth/session";
import { parseEmail } from "@/lib/email";
import { HttpError } from "@/lib/errors";
import { addMemberWithAccount, fetchUserEmails, type AccountResult } from "@/lib/tenants/members";

/**
 * Tenants de la plataforma (`/admin/tenants`, solo súper administrador) como el usuario
 * de la sesión. `requirePlatformAdmin` comprueba el rol y las escrituras en `tenants` y
 * `tenant_members` van con el cliente de la sesión, cuya RLS vuelve a exigir súper
 * administrador. La llave secreta solo lee correos de Auth y crea cuentas.
 */

export const MAX_TENANT_NAME = 100;

export interface TenantAdmin {
  userId: string;
  email: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  suspendedAt: string | null;
  createdAt: string;
  /** Administradores ordenados por correo. */
  admins: TenantAdmin[];
}

export interface CreatedTenant extends AccountResult {
  tenantId: string;
}

const NO_EXISTE = "El tenant no existe.";
const esUuid = (s: string) => z.guid().safeParse(s).success;

function parseName(valor: string): string {
  const nombre = valor.trim();
  if (nombre.length === 0) throw new HttpError(400, "Escribe el nombre del tenant.");
  if (nombre.length > MAX_TENANT_NAME) {
    throw new HttpError(400, `El nombre admite hasta ${MAX_TENANT_NAME} caracteres.`);
  }
  return nombre;
}

/** El tenant existe (el súper administrador ve todos), o 404. */
async function exigirTenant(supabase: SupabaseClient, tenantId: string): Promise<void> {
  if (!esUuid(tenantId)) throw new HttpError(404, NO_EXISTE);
  const { data, error } = await supabase.from("tenants").select("id").eq("id", tenantId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, NO_EXISTE);
}

/** Todos los tenants, ordenados por nombre, con sus administradores. */
export async function listTenantsAs(supabase: SupabaseClient): Promise<TenantSummary[]> {
  const { supabase: cliente } = await requirePlatformAdmin(supabase);
  const [tenants, admins] = await Promise.all([
    cliente
      .from("tenants")
      .select("id, name, suspended_at, created_at")
      .order("name")
      .overrideTypes<{ id: string; name: string; suspended_at: string | null; created_at: string }[], { merge: false }>(),
    cliente
      .from("tenant_members")
      .select("tenant_id, user_id")
      .eq("role", "admin")
      .overrideTypes<{ tenant_id: string; user_id: string }[], { merge: false }>(),
  ]);
  if (tenants.error) throw tenants.error;
  if (admins.error) throw admins.error;

  const correos = await fetchUserEmails([...new Set(admins.data.map((a) => a.user_id))]);
  const porTenant = new Map<string, TenantAdmin[]>();
  for (const a of admins.data) {
    const correo = correos.get(a.user_id);
    if (!correo) continue;
    porTenant.set(a.tenant_id, [
      ...(porTenant.get(a.tenant_id) ?? []),
      { userId: a.user_id, email: correo.email },
    ]);
  }

  return tenants.data.map((t) => ({
    id: t.id,
    name: t.name,
    suspendedAt: t.suspended_at,
    createdAt: t.created_at,
    admins: (porTenant.get(t.id) ?? []).sort((a, b) => a.email.localeCompare(b.email)),
  }));
}

/**
 * Crea un tenant y le da su primer `admin` con su cuenta, sin invitación (ver
 * `addMemberWithAccount`): crea el usuario ya confirmado con la contraseña dada, o reutiliza
 * el de una cuenta ya confirmada sin tocar su contraseña. Si algo falla, el tenant se borra
 * (con sus membresías) para no dejarlo sin administrador.
 */
export async function createTenantAs(
  supabase: SupabaseClient,
  name: string,
  adminEmail: string,
  password: string,
): Promise<CreatedTenant> {
  const { supabase: cliente } = await requirePlatformAdmin(supabase);
  const nombre = parseName(name);
  const email = parseEmail(adminEmail);
  const clave = parsePassword(password);

  const { data, error } = await cliente
    .from("tenants")
    .insert({ name: nombre })
    .select("id")
    .single<{ id: string }>();
  if (error) throw error;

  try {
    const resultado = await addMemberWithAccount(cliente, data.id, email, clave, "admin", true);
    return { tenantId: data.id, ...resultado };
  } catch (fallo) {
    const { error: errorBorrado } = await cliente.from("tenants").delete().eq("id", data.id);
    if (errorBorrado) throw errorBorrado;
    throw fallo;
  }
}

/** Suspende (sus miembros pierden el acceso; los datos se conservan) o reactiva un tenant. */
export async function setTenantSuspendedAs(
  supabase: SupabaseClient,
  tenantId: string,
  suspended: boolean,
): Promise<void> {
  const { supabase: cliente } = await requirePlatformAdmin(supabase);
  if (!esUuid(tenantId)) throw new HttpError(404, NO_EXISTE);
  const { data, error } = await cliente
    .from("tenants")
    .update({ suspended_at: suspended ? new Date().toISOString() : null })
    .eq("id", tenantId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, NO_EXISTE);
}

/** Da de alta, con su cuenta y sin invitación, a otro `admin` de un tenant existente. */
export async function addTenantAdminAs(
  supabase: SupabaseClient,
  tenantId: string,
  email: string,
  password: string,
): Promise<AccountResult> {
  const { supabase: cliente } = await requirePlatformAdmin(supabase);
  const correo = parseEmail(email);
  const clave = parsePassword(password);
  await exigirTenant(cliente, tenantId);
  return addMemberWithAccount(cliente, tenantId, correo, clave, "admin", true);
}
