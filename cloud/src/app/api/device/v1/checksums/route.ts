import { authenticateActiveDevice } from "@/lib/device/auth";
import { panelChecksums } from "@/lib/device/changes";
import { deviceJson, deviceRoute } from "@/lib/device/http";

/**
 * GET /api/device/v1/checksums (Device, panel `active`).
 * Responde `{revision, confirm_deletions, tables}` con el checksum de la proyección viva
 * de cada tabla para este panel (el agente los compara en la reconciliación diaria).
 */
export async function GET(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateActiveDevice(req);
    return deviceJson(await panelChecksums(panel));
  });
}
