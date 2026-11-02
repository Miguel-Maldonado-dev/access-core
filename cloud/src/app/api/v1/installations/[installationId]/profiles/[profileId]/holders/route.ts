import { apiJson, apiRoute, ApiError, readApiBody } from "@/lib/api/http";
import { cuerpoTitularesPerfil } from "@/lib/api/profiles";
import { currentRevision } from "@/lib/api/revision";
import { getProfileAs, listHolderOptionsAs, setProfileHoldersAs } from "@/lib/profiles";

type Contexto = { params: Promise<{ installationId: string; profileId: string }> };

/** PUT .../profiles/{id}/holders: deja el perfil asignado exactamente a esos titulares. */
export async function PUT(req: Request, { params }: Contexto) {
  const { installationId, profileId } = await params;
  return apiRoute(req, async (actor) => {
    const { holder_ids } = await readApiBody(req, cuerpoTitularesPerfil);
    // El perfil se valida primero (404); luego los titulares: en la API un titular ajeno o
    // inexistente es 400 (la interfaz conserva el 409 de la capa de datos).
    await getProfileAs(actor, actor.tenantId, installationId, profileId);
    const vivos = new Set((await listHolderOptionsAs(actor, actor.tenantId, installationId)).map((h) => h.id));
    if (holder_ids.some((id) => !vivos.has(id))) throw new ApiError(400, "bad_request", "El titular no existe.");
    await setProfileHoldersAs(actor, actor.tenantId, installationId, profileId, holder_ids);
    const data = await getProfileAs(actor, actor.tenantId, installationId, profileId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}
