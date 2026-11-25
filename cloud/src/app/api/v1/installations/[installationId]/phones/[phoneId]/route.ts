import { apiJson, apiRoute, readApiJson } from "@/lib/api/http";
import { operacionesTelefonos } from "@/lib/api/phones";
import { currentRevision } from "@/lib/api/revision";

type Contexto = { params: Promise<{ installationId: string; phoneId: string }> };

/** PATCH .../phones/{id}: cambia número, titular o descripción y conserva lo demás. */
export async function PATCH(req: Request, { params }: Contexto) {
  const { installationId, phoneId } = await params;
  return apiRoute(req, async (actor) => {
    const { data } = await operacionesTelefonos.update(actor, installationId, phoneId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}

/** DELETE .../phones/{id}: borrado lógico; `{data: {id}, revision}`. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, phoneId } = await params;
  return apiRoute(req, async (actor) => {
    const { data } = await operacionesTelefonos.delete(actor, installationId, phoneId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}
