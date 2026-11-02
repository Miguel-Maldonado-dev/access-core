import { apiJson, apiRoute, ApiError, readApiBody } from "@/lib/api/http";
import { cuerpoEditarTarjeta } from "@/lib/api/cards";
import { currentRevision } from "@/lib/api/revision";
import { deleteCardAs, getCardAs, updateCardAs } from "@/lib/cards";

type Contexto = { params: Promise<{ installationId: string; cardId: string }> };

/** PATCH .../cards/{id}: cambia titular o descripción y conserva lo demás. */
export async function PATCH(req: Request, { params }: Contexto) {
  const { installationId, cardId } = await params;
  return apiRoute(req, async (actor) => {
    const cambios = await readApiBody(req, cuerpoEditarTarjeta);
    if (Object.keys(cambios).length === 0) throw new ApiError(400, "bad_request", "No hay cambios.");
    const actual = await getCardAs(actor, actor.tenantId, installationId, cardId);
    await updateCardAs(actor, actor.tenantId, installationId, cardId, {
      holder_id: actual.holder_id,
      description: actual.description,
      ...cambios,
    });
    const data = await getCardAs(actor, actor.tenantId, installationId, cardId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}

/** DELETE .../cards/{id}: borrado lógico; `{data: {id}, revision}`. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, cardId } = await params;
  return apiRoute(req, async (actor) => {
    await deleteCardAs(actor, actor.tenantId, installationId, cardId);
    return apiJson({ data: { id: cardId }, revision: await currentRevision(installationId) });
  });
}
