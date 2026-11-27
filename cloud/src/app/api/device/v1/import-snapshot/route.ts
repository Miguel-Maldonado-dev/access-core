import { authenticateDevice } from "@/lib/device/auth";
import { importSnapshotRequestSchema } from "@/lib/device/contract";
import { DeviceApiError, deviceJson, deviceRoute, readJsonBody } from "@/lib/device/http";
import { notStaging, snapshotProblem, stageSnapshot } from "@/lib/device/imports";

/**
 * POST /api/device/v1/import-snapshot (Device, panel en `staging`).
 * Cuerpo `{tables:{<tabla>:[{id, data}]}}` con todas las tablas replicadas y los nombres
 * locales. Responde 202 `{status:"active"}` si la instalación estaba vacía y se importó
 * todo, o 202 `{status:"awaiting_review"}` si un administrador debe revisar el diff.
 * Panel fuera de `staging`: 409 `not_staging`. Cuerpo con otra forma: 400 `invalid_body`;
 * snapshot incoherente (referencias, valores únicos o reglas de QR de la base): 400
 * `invalid_snapshot`. Con `X-Acc-Schema` menor que 9 se ignoran los `qr_codes`.
 */
export async function POST(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateDevice(req);
    if (panel.status !== "staging") throw notStaging();
    const { tables } = await readJsonBody(req, importSnapshotRequestSchema);
    // Un panel anterior a v9 no conoce los QR: se ignoran aunque los mande.
    if (panel.schema < 9) tables.qr_codes = [];
    const problema = snapshotProblem(tables);
    if (problema) {
      throw new DeviceApiError(400, "invalid_snapshot", `El snapshot no es coherente: ${problema}`);
    }
    return deviceJson({ status: await stageSnapshot(panel, tables) }, 202);
  });
}
