import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { esUuid, requireInstallationAccess } from "@/lib/access-data";
import { HttpError } from "@/lib/errors";
import { publishToPanel } from "@/lib/mqtt/publish";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Órdenes de la interfaz a los paneles de una instalación, como el usuario de la sesión
 * (`supabase` con sesión): "Actualizar logs" (`upload_logs`) y "Probar" una salida
 * (`test_output`). Admin y técnico del tenant pueden usarlas. La visibilidad se comprueba
 * con RLS y el rol con `requireInstallationAccess`; las escrituras van con la llave
 * secreta porque `authenticated` no escribe `installations.logs_requested_at` ni
 * `panel_commands`. Se publican por MQTT en `acc/<panel_code>/cmd`.
 */

/** Una petición de "Actualizar logs" por instalación en este intervalo. */
export const LOGS_REQUEST_INTERVAL_MS = 10_000;
/** Vigencia de una orden de prueba: pasada esa hora el panel la descarta. */
export const TEST_OUTPUT_TTL_MS = 10_000;
/** Largo máximo de `requested_by` que acepta el agente del panel. */
const REQUESTED_BY_MAX = 120;

export type CommandStatus = "pending" | "ok" | "error" | "expired";

export interface LogsUploadRequest {
  /** Hora de la petición (ISO UTC): el `since` de `logsUploadStatusAs`. */
  requestedAt: string;
  /** Paneles activos de la instalación; solo a los que están en línea se les avisó. */
  panels: { id: string; panel_code: string; online: boolean }[];
}

const fechaIsoSchema = z.iso.datetime({ offset: true });

/** Paneles activos de la instalación (RLS), en orden de código. */
async function panelesActivos(cliente: SupabaseClient, installationId: string) {
  const { data, error } = await cliente
    .from("panels")
    .select("id, panel_code, online, logs_uploaded_at")
    .eq("installation_id", installationId)
    .eq("status", "active")
    .order("panel_code");
  if (error) throw error;
  return data as { id: string; panel_code: string; online: boolean; logs_uploaded_at: string | null }[];
}

/**
 * "Actualizar logs": marca `installations.logs_requested_at` y publica
 * `{type: "upload_logs"}` a cada panel activo en línea; un publish que falla no detiene
 * a los demás. Solo marca si la última petición tiene más de 10 s (en la misma
 * escritura, así que dos peticiones simultáneas no pasan las dos); si no, 429.
 */
export async function requestLogsUploadAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
): Promise<LogsUploadRequest> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");

  const ahora = Date.now();
  const requestedAt = new Date(ahora).toISOString();
  const limite = new Date(ahora - LOGS_REQUEST_INTERVAL_MS).toISOString();
  const { data: marcadas, error } = await createAdminSupabase()
    .from("installations")
    .update({ logs_requested_at: requestedAt })
    .eq("id", installationId)
    .eq("tenant_id", tenantId)
    .or(`logs_requested_at.is.null,logs_requested_at.lt."${limite}"`)
    .select("id");
  if (error) throw error;
  if (!marcadas.length) throw new HttpError(429, "Espera unos segundos antes de volver a actualizar.");

  const paneles = await panelesActivos(cliente, installationId);
  const enLinea = paneles.filter((p) => p.online);
  const resultados = await Promise.allSettled(enLinea.map((p) => publishToPanel(p.panel_code, { type: "upload_logs" })));
  resultados.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`Falló el aviso de subida de logs a ${enLinea[i].panel_code}:`, (r.reason as Error)?.message);
    }
  });

  return { requestedAt, panels: paneles.map(({ id, panel_code, online }) => ({ id, panel_code, online })) };
}

/**
 * Paneles activos en línea que aún no suben logs desde `since` (la `requestedAt` de
 * `requestLogsUploadAs`): `logs_uploaded_at` nulo o anterior. La página deja de esperar
 * cuando la lista queda vacía. `since` que no es una fecha ISO da 400.
 */
export async function logsUploadStatusAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  since: string,
): Promise<{ pending: string[] }> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  if (!fechaIsoSchema.safeParse(since).success) throw new HttpError(400, "La fecha no es válida.");
  const desde = Date.parse(since);

  const paneles = await panelesActivos(cliente, installationId);
  return {
    pending: paneles
      .filter((p) => p.online && (p.logs_uploaded_at === null || Date.parse(p.logs_uploaded_at) < desde))
      .map((p) => p.id),
  };
}

/**
 * "Probar" una salida: guarda una orden `test_output` (vigente 10 s) y la publica al panel
 * de la salida. La salida debe ser de la instalación (404) y su panel estar activo (409) y
 * en línea (409 "Panel sin conexión"). Si la salida ya tiene una orden pendiente vigente,
 * 409 "La salida ya se está probando" (lo garantiza el índice único de pendientes; antes se
 * marcan `expired` las pendientes ya caducadas). Si el publish falla, la orden queda
 * `error` y responde 502.
 */
export async function testOutputAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  outputId: string,
): Promise<{ commandId: string }> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;

  const noExiste = new HttpError(404, "La salida no existe.");
  if (!esUuid(outputId)) throw noExiste;
  const { data: salida, error: errorSalida } = await cliente
    .from("outputs")
    .select("id, panel_id, output_index")
    .eq("id", outputId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle<{ id: string; panel_id: string; output_index: number }>();
  if (errorSalida) throw errorSalida;
  if (!salida) throw noExiste;

  const { data: panel, error: errorPanel } = await cliente
    .from("panels")
    .select("id, panel_code, status, online")
    .eq("id", salida.panel_id)
    .eq("installation_id", installationId)
    .maybeSingle<{ id: string; panel_code: string; status: string; online: boolean }>();
  if (errorPanel) throw errorPanel;
  if (!panel || panel.status !== "active") throw new HttpError(409, "El panel de esta salida no está activo.");
  if (!panel.online) throw new HttpError(409, "Panel sin conexión");

  const admin = createAdminSupabase();
  const ahora = new Date();
  const { error: errorCaducadas } = await admin
    .from("panel_commands")
    .update({ status: "expired", finished_at: ahora.toISOString() })
    .eq("panel_id", panel.id)
    .eq("output_index", salida.output_index)
    .eq("status", "pending")
    .lt("expires_at", ahora.toISOString());
  if (errorCaducadas) throw errorCaducadas;

  // El panel compara `expires_at` con su reloj: viaja en ISO UTC (`toISOString`), nunca en
  // el formato de texto de Postgres (`+00`), que el agente en Python 3.9 no acepta.
  const expiresAt = new Date(ahora.getTime() + TEST_OUTPUT_TTL_MS).toISOString();
  const requestedBy = (acceso.email || acceso.userId).slice(0, REQUESTED_BY_MAX);
  const { data: orden, error: errorOrden } = await admin
    .from("panel_commands")
    .insert({
      tenant_id: tenantId,
      installation_id: installationId,
      panel_id: panel.id,
      kind: "test_output",
      output_index: salida.output_index,
      requested_by: requestedBy,
      requested_by_user: acceso.userId,
      expires_at: expiresAt,
    })
    .select("id")
    .single<{ id: string }>();
  if (errorOrden?.code === "23505") throw new HttpError(409, "La salida ya se está probando");
  if (errorOrden) throw errorOrden;

  try {
    await publishToPanel(panel.panel_code, {
      type: "test_output",
      command_id: orden.id,
      output: salida.output_index,
      requested_by: requestedBy,
      expires_at: expiresAt,
    });
  } catch (error) {
    console.error(`Falló la orden de prueba a ${panel.panel_code}:`, (error as Error)?.message);
    const { error: errorMarca } = await admin
      .from("panel_commands")
      .update({ status: "error", detail: "No se pudo enviar la orden", finished_at: new Date().toISOString() })
      .eq("id", orden.id)
      .eq("status", "pending");
    if (errorMarca) throw errorMarca;
    throw new HttpError(502, "No se pudo enviar la orden al panel. Intenta de nuevo.");
  }
  return { commandId: orden.id };
}

/**
 * Estado de una orden de la instalación (RLS); una que no existe o es de otra instalación
 * da 404. Una `pending` cuyo `expires_at` ya pasó se informa como `expired`.
 */
export async function commandStatusAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  commandId: string,
): Promise<{ status: CommandStatus; detail: string | null }> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "La orden no existe.");
  if (!esUuid(commandId)) throw noExiste;
  const { data: orden, error } = await cliente
    .from("panel_commands")
    .select("status, detail, expires_at")
    .eq("id", commandId)
    .eq("installation_id", installationId)
    .maybeSingle<{ status: CommandStatus; detail: string | null; expires_at: string }>();
  if (error) throw error;
  if (!orden) throw noExiste;
  if (orden.status === "pending" && Date.parse(orden.expires_at) < Date.now()) {
    return { status: "expired", detail: null };
  }
  return { status: orden.status, detail: orden.detail };
}
