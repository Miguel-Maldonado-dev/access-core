import { authenticateActiveDevice } from "@/lib/device/auth";
import { recordCommandResult } from "@/lib/device/commands";
import { commandResultSchema } from "@/lib/device/contract";
import { deviceRoute, readJsonBody } from "@/lib/device/http";

/**
 * POST /api/device/v1/command-result (Device, panel `active`).
 * Cuerpo `{command_id, ok, detail}`: el resultado de una orden de la nube (`test_output`).
 * Solo se acepta para una orden de ese panel (si no, 404 `not_found`); un resultado tardío
 * deja la orden `expired`. Responde 204.
 */
export async function POST(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateActiveDevice(req);
    await recordCommandResult(panel, await readJsonBody(req, commandResultSchema));
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });
}
