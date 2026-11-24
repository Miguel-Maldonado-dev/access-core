import { apiJson, apiRoute, readApiJson } from "@/lib/api/http";
import { findHolder, operacionesTitulares } from "@/lib/api/holders";
import { currentRevision } from "@/lib/api/revision";

type Contexto = { params: Promise<{ installationId: string; holderId: string }> };

/** GET .../holders/{id}: el titular; 404 si no existe o es de otra instalación o tenant. */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId, holderId } = await params;
  return apiRoute(req, async (actor) => {
    return apiJson({ data: await findHolder(actor, installationId, holderId) });
  });
}

/** PATCH .../holders/{id}: cambia solo los campos enviados y conserva el PIN. */
export async function PATCH(req: Request, { params }: Contexto) {
  const { installationId, holderId } = await params;
  return apiRoute(req, async (actor) => {
    const { data } = await operacionesTitulares.update(actor, installationId, holderId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}

/** DELETE .../holders/{id}: borrado lógico; `{data: {id}, revision}`. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, holderId } = await params;
  return apiRoute(req, async (actor) => {
    const { data } = await operacionesTitulares.delete(actor, installationId, holderId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}
