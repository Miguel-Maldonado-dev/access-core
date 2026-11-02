import { apiJson, apiRoute, ApiError, readApiBody } from "@/lib/api/http";
import { cuerpoRenombrarPerfil } from "@/lib/api/profiles";
import { currentRevision } from "@/lib/api/revision";
import { deleteProfileAs, getProfileAs, renameProfileAs } from "@/lib/profiles";

type Contexto = { params: Promise<{ installationId: string; profileId: string }> };

/** PATCH .../profiles/{id}: cambia el nombre. */
export async function PATCH(req: Request, { params }: Contexto) {
  const { installationId, profileId } = await params;
  return apiRoute(req, async (actor) => {
    const cambios = await readApiBody(req, cuerpoRenombrarPerfil);
    if (cambios.name === undefined) throw new ApiError(400, "bad_request", "No hay cambios.");
    await renameProfileAs(actor, actor.tenantId, installationId, profileId, cambios.name);
    const data = await getProfileAs(actor, actor.tenantId, installationId, profileId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}

/** DELETE .../profiles/{id}: borrado lógico (quita sus reglas y asignaciones); `{data: {id}, revision}`. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, profileId } = await params;
  return apiRoute(req, async (actor) => {
    await deleteProfileAs(actor, actor.tenantId, installationId, profileId);
    return apiJson({ data: { id: profileId }, revision: await currentRevision(installationId) });
  });
}
