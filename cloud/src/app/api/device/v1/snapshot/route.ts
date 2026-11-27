import { z } from "zod";
import { authenticateActiveDevice } from "@/lib/device/auth";
import { panelSnapshot } from "@/lib/device/changes";
import { tableNameSchema, tablesForSchema } from "@/lib/device/contract";
import { DeviceApiError, deviceJson, deviceRoute, readQuery } from "@/lib/device/http";

const consulta = z.object({ table: tableNameSchema });

/**
 * GET /api/device/v1/snapshot?table=T (Device, panel `active`).
 * Responde `{revision, rows:[{id, data}]}` con la proyección viva de la tabla para este
 * panel, ordenada por id. Una tabla que no es del contrato, o una que el esquema del panel
 * no conoce (`phones` y `call_settings` desde v8; `qr_codes` y `qr_settings` desde v9): 400.
 */
export async function GET(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateActiveDevice(req);
    const { table } = readQuery(req, consulta);
    if (!tablesForSchema(panel.schema).includes(table)) {
      throw new DeviceApiError(400, "invalid_query", "El parámetro table no es válido.");
    }
    return deviceJson(await panelSnapshot(panel, table));
  });
}
