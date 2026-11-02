import { apiJson, apiRoute, ApiError, readApiBody } from "@/lib/api/http";
import { cuerpoEditarTitular, entradaDe, findHolder } from "@/lib/api/holders";
import { currentRevision } from "@/lib/api/revision";
import { deleteHolderAs, updateHolderAs, type HolderInput } from "@/lib/holders";

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
    const cambios = await readApiBody(req, cuerpoEditarTitular);
    if (Object.keys(cambios).length === 0) throw new ApiError(400, "bad_request", "No hay cambios.");
    const actual = await findHolder(actor, installationId, holderId);
    await updateHolderAs(
      actor,
      actor.tenantId,
      installationId,
      holderId,
      entradaDe(actual, cambios as Partial<Omit<HolderInput, "pin">>),
    );
    const data = await findHolder(actor, installationId, holderId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}

/** DELETE .../holders/{id}: borrado lógico; `{data: {id}, revision}`. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, holderId } = await params;
  return apiRoute(req, async (actor) => {
    await deleteHolderAs(actor, actor.tenantId, installationId, holderId);
    return apiJson({ data: { id: holderId }, revision: await currentRevision(installationId) });
  });
}
