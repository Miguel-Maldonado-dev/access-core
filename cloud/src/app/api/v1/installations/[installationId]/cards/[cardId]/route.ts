import { apiJson, apiRoute, readApiJson } from "@/lib/api/http";
import { operacionesTarjetas } from "@/lib/api/cards";
import { currentRevision } from "@/lib/api/revision";

type Contexto = { params: Promise<{ installationId: string; cardId: string }> };

/** PATCH .../cards/{id}: cambia titular o descripción y conserva lo demás. */
export async function PATCH(req: Request, { params }: Contexto) {
  const { installationId, cardId } = await params;
  return apiRoute(req, async (actor) => {
    const { data } = await operacionesTarjetas.update(actor, installationId, cardId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}

/** DELETE .../cards/{id}: borrado lógico; `{data: {id}, revision}`. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, cardId } = await params;
  return apiRoute(req, async (actor) => {
    const { data } = await operacionesTarjetas.delete(actor, installationId, cardId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}
