import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll, requireInstallationAccess } from "@/lib/access-data";
import type { ConflictRow } from "@/lib/conflict-view";
import { HttpError } from "@/lib/errors";
import { LOG_PAGE_SIZE } from "@/lib/log-view";

/**
 * Conflictos de sincronización de una instalación como el usuario de la sesión (RLS; admin y
 * técnico). Un conflicto revisado sigue en la lista. `authenticated` solo puede escribir
 * `reviewed_at`: la hora y el autor (`reviewed_by`) los fija un trigger de la base.
 */

export interface ConflictPage {
  rows: ConflictRow[];
  total: number;
  page: number;
  pageSize: number;
}

const COLUMNAS = "id, panel_id, table_name, row_id, kind, resolution, created_at, reviewed_at";
const RANGO_FUERA = "PGRST103";
const NO_EXISTE = "El conflicto no existe.";

/** Una página de conflictos, del más reciente al más viejo (orden total `created_at desc, id desc`). */
export async function listConflictsAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  page: number,
): Promise<ConflictPage> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const desde = (page - 1) * LOG_PAGE_SIZE;
  const { data, count, error } = await cliente
    .from("sync_conflicts")
    .select(COLUMNAS, { count: "exact" })
    .eq("installation_id", installationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(desde, desde + LOG_PAGE_SIZE - 1);

  let filas = (data ?? []) as unknown as Omit<ConflictRow, "panel_code">[];
  let total = count ?? 0;
  if (error) {
    if (error.code !== RANGO_FUERA) throw error;
    const conteo = await cliente
      .from("sync_conflicts")
      .select("id", { count: "exact", head: true })
      .eq("installation_id", installationId);
    if (conteo.error) throw conteo.error;
    filas = [];
    total = conteo.count ?? 0;
  }

  const paneles = await fetchAll<{ id: string; panel_code: string }>((a, b) =>
    cliente.from("panels").select("id, panel_code").eq("installation_id", installationId).order("id").range(a, b),
  );
  const codigos = new Map(paneles.map((p) => [p.id, p.panel_code]));
  return {
    rows: filas.map((f) => ({ ...f, panel_code: codigos.get(f.panel_id) ?? "" })),
    total,
    page,
    pageSize: LOG_PAGE_SIZE,
  };
}

/**
 * Marca un conflicto de la instalación como revisado. Es idempotente: si ya estaba revisado
 * no cambia la fecha ni el autor. 404 si no existe en esta instalación (RLS oculta los de
 * otros tenants).
 */
export async function markConflictReviewedAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  conflictId: number,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  if (!Number.isSafeInteger(conflictId) || conflictId < 1) throw new HttpError(404, NO_EXISTE);

  // El valor lo reemplaza el trigger por la hora del servidor; solo hace falta que no sea null.
  const { data, error } = await cliente
    .from("sync_conflicts")
    .update({ reviewed_at: new Date().toISOString() })
    .eq("id", conflictId)
    .eq("installation_id", installationId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new HttpError(404, NO_EXISTE);
}
