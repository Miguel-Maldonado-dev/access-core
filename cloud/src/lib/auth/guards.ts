import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { forbidden, redirect } from "next/navigation";
import { z } from "zod";
import { HttpError } from "@/lib/errors";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Guardas de autorización para Server Components, Server Actions y Route Handlers.
 * Usan el cliente con la sesión del usuario, así que la membresía se lee con RLS
 * (`tenant_members` solo muestra filas de tenants activos de los que es miembro).
 * Fallan con `HttpError` (401 sin sesión, 403 sin permiso); en páginas y layouts,
 * `guardPage()` convierte esos errores en la redirección a /login o en `forbidden()`.
 *
 * El parámetro `supabase` es opcional: por omisión se crea el cliente de las cookies
 * de la petición; las pruebas pasan un cliente con sesión iniciada.
 */

export type TenantRole = "admin" | "tecnico";

export interface SessionUser {
  userId: string;
  /** Correo del JWT ("" si no lo trae). */
  email: string;
  supabase: SupabaseClient;
}

export interface TenantAccess extends SessionUser {
  tenantId: string;
  role: TenantRole;
}

const SIN_PERMISO = "No tienes permiso para esta acción.";

/** Usuario con sesión válida (JWT verificado) o 401. */
export async function requireUser(supabase?: SupabaseClient): Promise<SessionUser> {
  const cliente = supabase ?? (await createServerSupabase());
  const { data, error } = await cliente.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || !userId) {
    throw new HttpError(401, "Inicia sesión para continuar.");
  }
  const email = typeof data.claims.email === "string" ? data.claims.email : "";
  return { userId, email, supabase: cliente };
}

/**
 * ¿Es súper administrador? `platform_admins` no es legible para `authenticated`, así que
 * se consulta con la llave secreta, siempre con el `userId` de un JWT ya verificado.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data, error } = await createAdminSupabase()
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Súper administrador (tabla `platform_admins`), o 401 sin sesión y 403 sin el rol. */
export async function requirePlatformAdmin(supabase?: SupabaseClient): Promise<SessionUser> {
  const usuario = await requireUser(supabase);
  if (!(await isPlatformAdmin(usuario.userId))) throw new HttpError(403, SIN_PERMISO);
  return usuario;
}

/**
 * Miembro del tenant con al menos el rol pedido, o 403.
 * `tecnico` acepta también a `admin`; `admin` solo a `admin`.
 */
export async function requireTenantRole(
  tenantId: string,
  role: TenantRole,
  supabase?: SupabaseClient,
): Promise<TenantAccess> {
  const usuario = await requireUser(supabase);
  const sinPermiso = new HttpError(403, SIN_PERMISO);
  if (!z.guid().safeParse(tenantId).success) throw sinPermiso;

  const { data, error } = await usuario.supabase
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", usuario.userId)
    .maybeSingle<{ role: TenantRole }>();
  if (error) throw error;
  if (!data || (role === "admin" && data.role !== "admin")) throw sinPermiso;

  return { ...usuario, tenantId, role: data.role };
}

/**
 * Para páginas y layouts: espera la guarda (o una lectura que la incluya) y traduce sus
 * errores: 401 → redirección a /login, 403 → `forbidden()`, que muestra
 * `app/forbidden.tsx` en lugar del contenido (con `noindex`). Con Cache Components la
 * página ya envió su estructura estática, así que el estado HTTP queda en 200: la
 * protección es que el contenido nunca se genera. Los demás errores se propagan.
 */
export async function guardPage<T>(promesa: Promise<T>): Promise<T> {
  try {
    return await promesa;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login");
    if (error instanceof HttpError && error.status === 403) forbidden();
    throw error;
  }
}
