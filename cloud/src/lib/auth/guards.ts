import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { forbidden, notFound, redirect } from "next/navigation";
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
 *
 * `requireTenantRole` acepta además un actor de API (`ApiActor`, una llave ya verificada):
 * actúa como `admin` de su tenant y sus consultas usan la llave secreta, así que cada
 * consulta de la capa de datos se filtra explícitamente por instalación o tenant, y las
 * escrituras se firman con `autoria()`.
 */

export type TenantRole = "admin" | "tecnico";

export interface SessionUser {
  userId: string;
  /** Correo del JWT ("" si no lo trae). */
  email: string;
  supabase: SupabaseClient;
}

/** Llave de API ya verificada: actúa como `admin` del tenant, sin sesión de usuario. */
export interface ApiActor {
  kind: "api";
  tenantId: string;
  keyId: string;
  keyName: string;
}

/** Quien llama a la capa de datos: el cliente con la sesión del usuario o un actor de API. */
export type DataClient = SupabaseClient | ApiActor;

export function isApiActor(cliente: DataClient | undefined): cliente is ApiActor {
  return typeof cliente === "object" && cliente !== null && (cliente as { kind?: unknown }).kind === "api";
}

export interface TenantAccess {
  /** Usuario de la sesión; `null` con un actor de API. */
  userId: string | null;
  /** Correo del JWT ("" si no lo trae); con un actor de API, `api:<nombre de la llave>`. */
  email: string;
  /** Cliente con la sesión (RLS) o, con un actor de API, el de la llave secreta. */
  supabase: SupabaseClient;
  tenantId: string;
  role: TenantRole;
  actor?: ApiActor;
}

/** Acceso de un usuario con sesión (nunca de un actor de API). */
export interface UserTenantAccess extends TenantAccess {
  userId: string;
  actor?: undefined;
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

/** Mismo texto en todos los casos: no revela si el tenant o la instalación existen. */
const NO_EXISTE = "La instalación no existe.";

/**
 * Miembro del tenant con al menos el rol pedido, o 403.
 * `tecnico` acepta también a `admin`; `admin` solo a `admin`.
 * Con un actor de API: si la llave es de otro tenant, 404 (nunca 403); si es del tenant,
 * acceso de `admin` con el cliente de la llave secreta.
 */
export async function requireTenantRole(
  tenantId: string,
  role: TenantRole,
  supabase?: SupabaseClient,
): Promise<UserTenantAccess>;
export async function requireTenantRole(tenantId: string, role: TenantRole, supabase?: DataClient): Promise<TenantAccess>;
export async function requireTenantRole(
  tenantId: string,
  role: TenantRole,
  supabase?: DataClient,
): Promise<TenantAccess> {
  if (isApiActor(supabase)) {
    if (supabase.tenantId !== tenantId) throw new HttpError(404, NO_EXISTE);
    return {
      userId: null,
      email: `api:${supabase.keyName}`,
      supabase: createAdminSupabase(),
      tenantId,
      role: "admin",
      actor: supabase,
    };
  }
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
 * Columnas de autoría para insertar o actualizar una tabla replicada. Con un usuario, `{}`:
 * el trigger firma `user:<uid>` (y `authenticated` no puede escribir esas columnas). Con un
 * actor de API (llave secreta, `auth.uid()` nulo) el trigger respeta lo que se manda.
 */
export function autoria(acceso: TenantAccess): Record<string, string> {
  if (!acceso.actor) return {};
  return { updated_by: `api:${acceso.actor.keyId}`, origin: "cloud", updated_at: new Date().toISOString() };
}

/**
 * Para páginas y layouts: espera la guarda (o una lectura que la incluya) y traduce sus
 * errores: 401 → redirección a /login, 403 → `forbidden()`, que muestra
 * `app/forbidden.tsx` en lugar del contenido (con `noindex`), y 404 → `notFound()` (una
 * lectura que gana la carrera en un `Promise.all` puede ser la que no encuentra el recurso). Con Cache Components la
 * página ya envió su estructura estática, así que el estado HTTP queda en 200: la
 * protección es que el contenido nunca se genera. Los demás errores se propagan.
 */
export async function guardPage<T>(promesa: Promise<T>): Promise<T> {
  try {
    return await promesa;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login");
    if (error instanceof HttpError && error.status === 403) forbidden();
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  }
}
