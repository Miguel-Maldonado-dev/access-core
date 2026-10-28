import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll, holderNames, requireInstallationAccess } from "@/lib/access-data";
import { LOG_PAGE_SIZE, localDayStartUtc, nextDay, type LogFilters, type LogRow } from "@/lib/log-view";

/**
 * Logs de acceso de una instalación como el usuario de la sesión (RLS; admin y técnico),
 * después de comprobar que la instalación es del tenant. Los logs de PIN nunca traen código
 * (la tabla lo impide). El alias de la salida se resuelve entre las salidas vivas del panel.
 */

export interface LogPage {
  rows: LogRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LogFilterOptions {
  panels: { id: string; panel_code: string }[];
  holders: { id: string; name: string }[];
}

type FilaLog = Omit<LogRow, "panel_code" | "output_alias">;

const COLUMNAS =
  "id, ts, panel_id, allowed, source, reason, holder_id, holder_name, holder_kind, credential_label, control_id, code, device_id, output_index";

/**
 * Forma mínima del constructor de consultas de PostgREST que usa `listLogsAs`. Se tipa a mano
 * porque el tipo real de `select()` con esta lista de columnas es tan profundo que TypeScript
 * se rinde (TS2589) al pasarlo por una función genérica.
 */
interface Consulta extends PromiseLike<{ data: unknown; count: number | null; error: { code?: string; message: string } | null }> {
  eq(columna: string, valor: unknown): Consulta;
  gte(columna: string, valor: string): Consulta;
  lt(columna: string, valor: string): Consulta;
  order(columna: string, opciones: { ascending: boolean }): Consulta;
  range(desde: number, hasta: number): Consulta;
}

/** Código de PostgREST: el rango pedido empieza después de la última fila. */
const RANGO_FUERA = "PGRST103";

/** Una página de logs, del más reciente al más viejo (orden total `ts desc, id desc`). */
export async function listLogsAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  filtros: LogFilters,
): Promise<LogPage> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");

  // Los filtros se aplican igual a la consulta de la página y a la del conteo.
  const filtrar = (consulta: Consulta): Consulta => {
    let q = consulta.eq("installation_id", installationId);
    if (filtros.panelId) q = q.eq("panel_id", filtros.panelId);
    if (filtros.holderId) q = q.eq("holder_id", filtros.holderId);
    if (filtros.allowed !== undefined) q = q.eq("allowed", filtros.allowed);
    if (filtros.source !== undefined) q = q.eq("source", filtros.source);
    if (filtros.from) q = q.gte("ts", localDayStartUtc(filtros.from));
    if (filtros.to) q = q.lt("ts", localDayStartUtc(nextDay(filtros.to)));
    return q;
  };
  const logs = () => cliente.from("access_logs");

  const desde = (filtros.page - 1) * LOG_PAGE_SIZE;
  const { data, count, error } = await filtrar(logs().select(COLUMNAS, { count: "exact" }) as unknown as Consulta)
    .order("ts", { ascending: false })
    .order("id", { ascending: false })
    .range(desde, desde + LOG_PAGE_SIZE - 1);

  let filas = (data ?? []) as FilaLog[];
  let total = count ?? 0;
  if (error) {
    if (error.code !== RANGO_FUERA) throw error;
    // Página después de la última: lista vacía, pero con el total para poder volver.
    const conteo = await filtrar(logs().select("id", { count: "exact", head: true }) as unknown as Consulta);
    if (conteo.error) throw conteo.error;
    filas = [];
    total = conteo.count ?? 0;
  }

  const [paneles, salidas] = await Promise.all([
    fetchAll<{ id: string; panel_code: string }>((a, b) =>
      cliente.from("panels").select("id, panel_code").eq("installation_id", installationId).order("id").range(a, b),
    ),
    fetchAll<{ panel_id: string; output_index: number; alias: string }>((a, b) =>
      cliente
        .from("outputs")
        .select("panel_id, output_index, alias")
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("panel_id")
        .order("output_index")
        .range(a, b),
    ),
  ]);
  const codigos = new Map(paneles.map((p) => [p.id, p.panel_code]));
  const alias = new Map(salidas.map((o) => [`${o.panel_id}:${o.output_index}`, o.alias.trim() || null]));

  return {
    rows: filas.map((f) => ({
      ...f,
      panel_code: codigos.get(f.panel_id) ?? "",
      output_alias: f.output_index === null ? null : (alias.get(`${f.panel_id}:${f.output_index}`) ?? null),
    })),
    total,
    page: filtros.page,
    pageSize: LOG_PAGE_SIZE,
  };
}

/** Paneles de la instalación y titulares vivos (por nombre) para los selectores de filtro. */
export async function listLogFilterOptionsAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
): Promise<LogFilterOptions> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const [paneles, titulares] = await Promise.all([
    fetchAll<{ id: string; panel_code: string }>((a, b) =>
      cliente.from("panels").select("id, panel_code").eq("installation_id", installationId).order("panel_code").order("id").range(a, b),
    ),
    holderNames(cliente, installationId),
  ]);
  return {
    panels: paneles,
    holders: [...titulares].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id)),
  };
}
