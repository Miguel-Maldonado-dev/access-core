import { apiJson, apiRoute } from "@/lib/api/http";
import { deleteQrCodeAs, getQrCodeAs } from "@/lib/qr-codes";

type Contexto = { params: Promise<{ installationId: string; qrId: string }> };

/** GET .../qr-codes/{id}: un QR vivo. Un QR no se edita (sin PATCH ni PUT). */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId, qrId } = await params;
  return apiRoute(req, async (actor) => apiJson({ data: await getQrCodeAs(actor, actor.tenantId, installationId, qrId) }));
}

/** DELETE .../qr-codes/{id}: revoca el QR (borrado lógico); 204 sin cuerpo. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, qrId } = await params;
  return apiRoute(req, async (actor) => {
    await deleteQrCodeAs(actor, actor.tenantId, installationId, qrId);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  });
}
