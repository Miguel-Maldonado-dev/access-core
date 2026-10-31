import { authenticateActiveDevice } from "@/lib/device/auth";
import { logsRequestSchema } from "@/lib/device/contract";
import { deviceJson, deviceRoute, readJsonBody } from "@/lib/device/http";
import { storeLogs } from "@/lib/device/logs";

/**
 * POST /api/device/v1/logs (Device, panel `active`).
 * Cuerpo `{logs:[...]}` con 0 a `LOG_BATCH` logs; si no es válido, 400 `invalid_body` sin
 * guardar nada. Es idempotente por `local_log_id`: reenviar un lote no duplica filas.
 * Toda subida válida, incluso vacía (respuesta a "Actualizar logs" sin logs pendientes),
 * marca `panels.logs_uploaded_at`.
 * Responde `{accepted, last_local_log_id}` (todos los logs recibidos y el mayor id local;
 * con la lista vacía, `{accepted: 0, last_local_log_id: 0}`: el agente espera un objeto JSON).
 */
export async function POST(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateActiveDevice(req);
    const { logs } = await readJsonBody(req, logsRequestSchema);
    return deviceJson(await storeLogs(panel, logs));
  });
}
