import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireTenantRole, type TenantAccess, type TenantRole } from "@/lib/auth/guards";
import { HttpError } from "@/lib/errors";

/**
 * Base común de titulares, tarjetas y controles: guarda de acceso a la instalación,
 * lectura de nombres de titulares y traducción de errores de la base. Todo con el cliente
 * de la sesión (RLS); solo la lectura/escritura del PIN usa la llave secreta, en `holders.ts`.
 */

export const esUuid = (s: unknown): s is string => z.guid().safeParse(s).success;

export interface InstallationAccess extends TenantAccess {
  installationId: string;
}

/**
 * Miembro del tenant con el rol pedido (403) y la instalación debe ser de ese tenant (404).
 * El tenant sale de la URL; la instalación se comprueba con RLS.
 */
export async function requireInstallationAccess(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  role: TenantRole,
): Promise<InstallationAccess> {
  const acceso = await requireTenantRole(tenantId, role, supabase);
  const noExiste = new HttpError(404, "La instalación no existe.");
  if (!esUuid(installationId)) throw noExiste;
  const { data, error } = await acceso.supabase
    .from("installations")
    .select("id")
    .eq("id", installationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw noExiste;
  return { ...acceso, installationId };
}

/**
 * Tamaño de página de `fetchAll`: el `max_rows` de la Data API (1000 por omisión), que corta
 * en silencio cualquier consulta más larga. Es un objeto para que las pruebas lo bajen.
 */
export const paging = { size: 1000 };

/**
 * Lee TODAS las filas de una consulta recorriéndola por páginas con `.range()`. La consulta
 * debe tener un orden total (el id como desempate) para que las páginas no se solapen ni
 * pierdan filas. `construir` arma la consulta completa para el rango pedido.
 */
export async function fetchAll<T>(
  construir: (desde: number, hasta: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const filas: T[] = [];
  for (let desde = 0; ; desde += paging.size) {
    const { data, error } = await construir(desde, desde + paging.size - 1);
    if (error) throw error;
    const pagina = (data ?? []) as T[];
    filas.push(...pagina);
    if (pagina.length < paging.size) return filas;
  }
}

/** Nombres de titulares vivos de la instalación, por id. */
export async function holderNames(
  supabase: SupabaseClient,
  installationId: string,
  ids?: string[],
): Promise<Map<string, string>> {
  if (ids && ids.length === 0) return new Map();
  const filas = await fetchAll<{ id: string; name: string }>((desde, hasta) => {
    let consulta = supabase.from("holders").select("id, name").eq("installation_id", installationId).is("deleted_at", null);
    if (ids) consulta = consulta.in("id", ids);
    return consulta.order("id").range(desde, hasta);
  });
  return new Map(filas.map((h) => [h.id, h.name]));
}

/** 400 si el titular no existe (vivo) en la instalación. */
export async function requireHolder(supabase: SupabaseClient, installationId: string, holderId: unknown): Promise<string> {
  if (!esUuid(holderId)) throw new HttpError(400, "Elige un titular.");
  const nombres = await holderNames(supabase, installationId, [holderId]);
  if (!nombres.has(holderId)) throw new HttpError(400, "El titular no existe.");
  return holderId;
}

interface ErrorBase {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * Choque de la restricción de unicidad con ese nombre (23505). Un índice único lo nombra en
 * el mensaje; un trigger que lanza unique_violation lo pone en `details`, porque PostgREST
 * no expone el campo `constraint`.
 */
export function isUniqueViolation(error: ErrorBase | null, restriccion: string): boolean {
  return error?.code === "23505" && [error.message, error.details].some((t) => (t ?? "").includes(restriccion));
}

/** Una fila viva apuntaba a un titular o control borrado entre la comprobación y la escritura (23503). */
export function isMissingParent(error: ErrorBase | null): boolean {
  return error?.code === "23503";
}

export const HOLDER_GONE = "El titular ya no existe.";
