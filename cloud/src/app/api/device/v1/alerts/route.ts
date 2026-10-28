import { authenticateActiveDevice } from "@/lib/device/auth";
import { alertRequestSchema } from "@/lib/device/contract";
import { deviceRoute, readJsonBody } from "@/lib/device/http";
import { recordAlert } from "@/lib/device/logs";

/**
 * POST /api/device/v1/alerts (Device, panel `active`).
 * Cuerpo `{type:"mass_delete_blocked", table, would_delete, total}`: el panel bloqueó un
 * borrado masivo. Queda en `panels.sync_blocked` hasta que un admin confirma los borrados.
 * Responde 204.
 */
export async function POST(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateActiveDevice(req);
    await recordAlert(panel, await readJsonBody(req, alertRequestSchema));
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });
}
