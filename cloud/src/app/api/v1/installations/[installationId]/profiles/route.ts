import { apiJson, apiRoute, readApiBody } from "@/lib/api/http";
import { cuerpoCrearPerfil } from "@/lib/api/profiles";
import { currentRevision } from "@/lib/api/revision";
import { createProfileAs, getProfileAs, listProfilesAs } from "@/lib/profiles";

type Contexto = { params: Promise<{ installationId: string }> };

/** GET .../profiles: perfiles vivos con sus reglas por panel y sus titulares. */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    return apiJson({ data: await listProfilesAs(actor, actor.tenantId, installationId) });
  });
}

/** POST .../profiles: crea un perfil con el menor número de permiso libre. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { name } = await readApiBody(req, cuerpoCrearPerfil);
    const { id } = await createProfileAs(actor, actor.tenantId, installationId, name);
    const data = await getProfileAs(actor, actor.tenantId, installationId, id);
    return apiJson({ data, revision: await currentRevision(installationId) }, 201);
  });
}
