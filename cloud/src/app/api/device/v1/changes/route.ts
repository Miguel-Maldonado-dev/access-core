import { z } from "zod";
import { applyPanelChanges } from "@/lib/device/apply";
import { authenticateActiveDevice } from "@/lib/device/auth";
import { listChanges } from "@/lib/device/changes";
import { CHANGES_PAGE, pushRequestSchema } from "@/lib/device/contract";
import { deviceJson, deviceRoute, readJsonBody, readQuery } from "@/lib/device/http";

/** Entero ≥ 0 escrito en decimal (hasta 15 dígitos: siempre un entero seguro). */
const enteroEnTexto = z
  .string()
  .regex(/^[0-9]{1,15}$/)
  .transform(Number);

const consulta = z.object({
  since: enteroEnTexto,
  limit: enteroEnTexto.pipe(z.int().min(1).max(CHANGES_PAGE)).optional(),
});

/**
 * GET /api/device/v1/changes?since=R&limit=N (Device, panel `active`).
 * Responde `{revision, has_more, confirm_deletions, changes}` con los cambios de la
 * instalación proyectados para este panel, ordenados por revisión. `limit` va de 1 a
 * `CHANGES_PAGE` (por omisión, `CHANGES_PAGE`); `since` o `limit` inválidos: 400.
 */
export async function GET(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateActiveDevice(req);
    const { since, limit = CHANGES_PAGE } = readQuery(req, consulta);
    return deviceJson(await listChanges(panel, since, limit));
  });
}

/**
 * POST /api/device/v1/changes (Device, panel `active`).
 * Cuerpo `{changes:[{change_id, table, op, id, updated_at, data?}]}` con hasta
 * `CHANGES_PAGE` cambios; si no es válido, 400 `invalid_body` sin aplicar nada.
 * Responde `{revision, results}`, un resultado por cambio y en el mismo orden.
 */
export async function POST(req: Request) {
  return deviceRoute(async () => {
    const panel = await authenticateActiveDevice(req);
    const { changes } = await readJsonBody(req, pushRequestSchema);
    return deviceJson(await applyPanelChanges(panel, changes));
  });
}
