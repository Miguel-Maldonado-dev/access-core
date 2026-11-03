import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { esUuid, type InstallationAccess, requireInstallationAccess } from "@/lib/access-data";
import type { DataClient } from "@/lib/auth/guards";
import { HttpError } from "@/lib/errors";
import { PublicacionNoEntregada, publishToPanel } from "@/lib/mqtt/publish";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Órdenes de la interfaz a los paneles de una instalación, como el usuario de la sesión
 * (`supabase` con sesión): "Actualizar logs" (`upload_logs`) y "Probar" una salida
 * (`test_output`). Admin y técnico del tenant pueden usarlas. La visibilidad se comprueba
 * con RLS y el rol con `requireInstallationAccess`; las escrituras van con la llave
 * secreta porque `authenticated` no escribe `installations.logs_requested_at` ni
 * `panel_commands`. Se publican por MQTT en `acc/<panel_code>/cmd`. La apertura remota
 * (`remote_open`, `remoteOpenAs` y `awaitCommand`) la usa la API pública con un actor de API.
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

/** Lo que distingue a cada tipo de orden de salida en `enviarOrdenDeSalida`. */
interface OrdenDeSalida {
  kind: "test_output" | "remote_open";
  requestedBy: string;
  /** Titular de la apertura (`remote_open`); viaja al panel como `holder_uuid`. */
  holderId?: string;
  /** 409 si el panel de la salida no está activo. */
  panelInactivo: string;
  /** 409 si la salida ya tiene una orden pendiente vigente. */
  ocupada: string;
  /** Para el log de un publish que falla. */
  etiqueta: string;
  /**
   * Validación extra después de comprobar que la salida existe. Si devuelve un id (el del
   * titular, como lo guarda la base), ese es el que se guarda y se publica.
   */
  validar?: () => Promise<string | void>;
}

/**
 * Guarda una orden de salida (vigente 10 s) y la publica al panel de la salida. La salida
 * debe ser de la instalación (404) y su panel estar activo (409 `panelInactivo`) y en línea
 * (409 "Panel sin conexión"). Si la salida ya tiene una orden pendiente vigente, 409
 * `ocupada` (lo garantiza el índice único de pendientes; antes se marcan `expired` las
 * pendientes ya caducadas).
 *
 * Si el publish falla, la orden queda `error` y responde 502, salvo en `remote_open` con un
 * fallo ambiguo (red o tiempo agotado, no `PublicacionNoEntregada`): EMQX pudo entregarla,
 * así que se deja pendiente (vence sola a los 10 s) y se sigue con la espera. Un 502 ahí
 * liberaría la salida y la `Idempotency-Key`, y un reintento abriría la puerta otra vez.
 */
async function enviarOrdenDeSalida(
  acceso: InstallationAccess,
  installationId: string,
  outputId: string,
  orden: OrdenDeSalida,
): Promise<{ commandId: string }> {
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
  const holderId = (await orden.validar?.()) || orden.holderId;

  const { data: panel, error: errorPanel } = await cliente
    .from("panels")
    .select("id, panel_code, status, online")
    .eq("id", salida.panel_id)
    .eq("installation_id", installationId)
    .maybeSingle<{ id: string; panel_code: string; status: string; online: boolean }>();
  if (errorPanel) throw errorPanel;
  if (!panel || panel.status !== "active") throw new HttpError(409, orden.panelInactivo);
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
  const requestedBy = orden.requestedBy.slice(0, REQUESTED_BY_MAX);
  const { data: fila, error: errorOrden } = await admin
    .from("panel_commands")
    .insert({
      tenant_id: acceso.tenantId,
      installation_id: installationId,
      panel_id: panel.id,
      kind: orden.kind,
      output_index: salida.output_index,
      requested_by: requestedBy,
      requested_by_user: acceso.userId,
      ...(holderId ? { holder_id: holderId } : {}),
      expires_at: expiresAt,
    })
    .select("id")
    .single<{ id: string }>();
  if (errorOrden?.code === "23505") throw new HttpError(409, orden.ocupada);
  if (errorOrden) throw errorOrden;

  try {
    await publishToPanel(panel.panel_code, {
      type: orden.kind,
      command_id: fila.id,
      output: salida.output_index,
      ...(holderId ? { holder_uuid: holderId } : {}),
      requested_by: requestedBy,
      expires_at: expiresAt,
    });
  } catch (error) {
    console.error(`Falló la orden de ${orden.etiqueta} a ${panel.panel_code}:`, (error as Error)?.message);
    if (orden.kind === "remote_open" && !(error instanceof PublicacionNoEntregada)) {
      return { commandId: fila.id };
    }
    const { error: errorMarca } = await admin
      .from("panel_commands")
      .update({ status: "error", detail: "No se pudo enviar la orden", finished_at: new Date().toISOString() })
      .eq("id", fila.id)
      .eq("status", "pending");
    if (errorMarca) throw errorMarca;
    throw new HttpError(502, "No se pudo enviar la orden al panel. Intenta de nuevo.");
  }
  return { commandId: fila.id };
}

/**
 * "Probar" una salida: guarda una orden `test_output` (vigente 10 s) y la publica al panel
 * de la salida. La salida debe ser de la instalación (404) y su panel estar activo (409) y
 * en línea (409 "Panel sin conexión"). Si la salida ya tiene una orden pendiente vigente,
 * 409 "La salida ya está en uso" (lo garantiza el índice único de pendientes; antes se
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
  return enviarOrdenDeSalida(acceso, installationId, outputId, {
    kind: "test_output",
    requestedBy: acceso.email || acceso.userId,
    panelInactivo: "El panel de esta salida no está activo.",
    ocupada: "La salida ya está en uso",
    etiqueta: "prueba",
  });
}

/**
 * Apertura remota de una salida a nombre de un titular: guarda una orden `remote_open`
 * (vigente 10 s) y la publica al panel con `holder_uuid`. Con un actor de API el rol
 * `tecnico` equivale a admin. En orden: salida inexistente 404; el titular debe estar vivo
 * en la instalación (400 "El titular no existe."; la FK de `panel_commands` acepta
 * titulares borrados, por eso se comprueba aquí); panel no activo o sin conexión 409
 * "Panel sin conexión"; orden pendiente en la salida 409; EMQX rechazó el mensaje 502 (un
 * fallo de red no da 502: ver `enviarOrdenDeSalida`). `requestedBy` se recorta a 120 y se
 * publica el id del titular que devuelve la base (en minúsculas).
 */
export async function remoteOpenAs(
  client: DataClient,
  tenantId: string,
  installationId: string,
  outputId: string,
  holderId: string,
  requestedBy: string,
): Promise<{ commandId: string }> {
  const acceso = await requireInstallationAccess(client, tenantId, installationId, "tecnico");

  const validarTitular = async () => {
    const sinTitular = new HttpError(400, "El titular no existe.");
    if (!esUuid(holderId)) throw sinTitular;
    const { data: titular, error } = await acceso.supabase
      .from("holders")
      .select("id")
      .eq("id", holderId)
      .eq("installation_id", installationId)
      .is("deleted_at", null)
      .maybeSingle<{ id: string }>();
    if (error) throw error;
    if (!titular) throw sinTitular;
    return titular.id;
  };

  return enviarOrdenDeSalida(acceso, installationId, outputId, {
    kind: "remote_open",
    requestedBy,
    holderId,
    panelInactivo: "Panel sin conexión",
    ocupada: "La salida ya tiene una orden en curso.",
    etiqueta: "apertura remota",
    validar: validarTitular,
  });
}

export type RemoteOpenStatus = "opened" | "denied" | "failed" | "timeout";

export interface RemoteOpenResult {
  status: RemoteOpenStatus;
  reason: number | null;
  detail: string | null;
}

/** Plazos de `awaitCommand`; es un objeto para que las pruebas los bajen. */
export const remoteOpenLimits = {
  /** Cuánto espera la API la confirmación del panel. */
  waitMs: 8000,
  /** Cada cuánto consulta la orden. */
  pollMs: 250,
};

/**
 * La orden de `awaitCommand`; `null` si la lectura falla o la fila no aparece. El cliente
 * se crea aquí, dentro del `try`: si falla (p. ej. sin configuración) cuenta como lectura
 * fallida y `awaitCommand` no lanza.
 */
async function leerOrden(
  commandId: string,
): Promise<{ status: CommandStatus; reason: number | null; detail: string | null } | null> {
  try {
    const { data, error } = await createAdminSupabase()
      .from("panel_commands")
      .select("status, reason, detail")
      .eq("id", commandId)
      .maybeSingle<{ status: CommandStatus; reason: number | null; detail: string | null }>();
    if (error) {
      console.error(`Falló la lectura de la orden ${commandId}:`, error.message);
      return null;
    }
    return data;
  } catch (error) {
    console.error(`Falló la lectura de la orden ${commandId}:`, (error as Error)?.message);
    return null;
  }
}

/** Motivos del panel que son un rechazo de la apertura: salida (2), permiso (3) y titular (11). */
const MOTIVOS_DENEGADA = new Set([2, 3, 11]);

/**
 * Espera el resultado de una orden consultándola con la llave secreta cada
 * `remoteOpenLimits.pollMs`. `ok` → `opened`; `error` con motivo 2, 3 u 11 → `denied`;
 * otro `error` (incluida la salida ocupada, motivo 0, o sin motivo) → `failed`; `expired`
 * o sin resultado en `timeoutMs` → `timeout`.
 *
 * Nunca lanza: la orden ya se publicó, y un 5xx liberaría la `Idempotency-Key`, así que un
 * reintento publicaría otra apertura. Un error de lectura (o la fila que no aparece) cuenta
 * como "sigue pendiente" y se vuelve a consultar hasta el plazo.
 */
export async function awaitCommand(
  commandId: string,
  timeoutMs: number = remoteOpenLimits.waitMs,
): Promise<RemoteOpenResult> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const orden = await leerOrden(commandId);
    if (orden?.status === "ok") return { status: "opened", reason: orden.reason, detail: orden.detail };
    if (orden?.status === "error") {
      const denegada = orden.reason !== null && MOTIVOS_DENEGADA.has(orden.reason);
      return { status: denegada ? "denied" : "failed", reason: orden.reason, detail: orden.detail };
    }
    const resta = limite - Date.now();
    if (orden?.status === "expired" || resta <= 0) return { status: "timeout", reason: null, detail: null };
    await new Promise((resolve) => setTimeout(resolve, Math.min(remoteOpenLimits.pollMs, resta)));
  }
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
