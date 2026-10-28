import { z } from "zod";
import { authenticateActiveDevice } from "@/lib/device/auth";
import { panelSnapshot } from "@/lib/device/changes";
import { tableNameSchema } from "@/lib/device/contract";
import { deviceJson, deviceRoute, readQuery } from "@/lib/device/http";

const consulta = z.object({ table: tableNameSchema });

/**
 * GET /api/device/v1/snapshot?table=T (Device, panel `active`).
 * Responde `{revision, rows:[{id, data}]}` con la proyección viva de la tabla para este
 * panel, ordenada por id. Una tabla que no es del contrato: 400.
 */
export async function GET(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateActiveDevice(req);
    const { table } = readQuery(req, consulta);
    return deviceJson(await panelSnapshot(panel, table));
  });
}
