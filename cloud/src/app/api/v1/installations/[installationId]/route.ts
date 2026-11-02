import { apiJson, apiRoute } from "@/lib/api/http";
import { HttpError } from "@/lib/errors";
import { getInstallationAs } from "@/lib/installations";

type Contexto = { params: Promise<{ installationId: string }> };

/** GET /api/v1/installations/{id}: `{data: {id, name, revision}}`; 404 si no es del tenant. */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const instalacion = await getInstallationAs(actor, actor.tenantId, installationId);
    if (!instalacion) throw new HttpError(404, "La instalación no existe.");
    return apiJson({ data: instalacion });
  });
}
