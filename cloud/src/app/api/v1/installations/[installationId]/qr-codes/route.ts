import { z } from "zod";
import { ApiError, apiJson, apiRoute, readApiJson, readApiQuery } from "@/lib/api/http";
import { operacionesQr } from "@/lib/api/qr-codes";
import { currentRevision } from "@/lib/api/revision";
import { esUuid } from "@/lib/access-data";
import { listQrCodesAs } from "@/lib/qr-codes";

type Contexto = { params: Promise<{ installationId: string }> };

const consulta = z.strictObject({
  holder_id: z.string().optional(),
  status: z.enum(["pending", "active", "expired"]).optional(),
});

/**
 * GET .../qr-codes: QR vivos (no revocados) con el nombre del anfitrión, más nuevos primero.
 * `?holder_id=` filtra por anfitrión y `?status=pending|active|expired` por vigencia.
 */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { holder_id, status } = readApiQuery(req, consulta);
    if (holder_id !== undefined && !esUuid(holder_id)) {
      throw new ApiError(400, "bad_request", "El parámetro holder_id no es válido.");
    }
    const data = await listQrCodesAs(actor, actor.tenantId, installationId, { holderId: holder_id, status });
    return apiJson({ data });
  });
}

/** POST .../qr-codes: crea un QR con código aleatorio; 422 si se rebasa el tope de vigentes. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { status, data } = await operacionesQr.create(actor, installationId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) }, status);
  });
}
