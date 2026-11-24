import { apiJson, apiRoute, readApiJson } from "@/lib/api/http";
import { operacionesTitulares } from "@/lib/api/holders";
import { currentRevision } from "@/lib/api/revision";
import { listHoldersAs } from "@/lib/holders";

type Contexto = { params: Promise<{ installationId: string }> };

/** GET .../holders: titulares vivos con `has_pin` (nunca el PIN). */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    return apiJson({ data: await listHoldersAs(actor, actor.tenantId, installationId) });
  });
}

/** POST .../holders: crea un titular sin PIN (el PIN se pone con `PUT .../pin`). */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { status, data } = await operacionesTitulares.create(actor, installationId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) }, status);
  });
}
