import { apiJson, apiRoute } from "@/lib/api/http";
import { listOutputsAs } from "@/lib/outputs";

type Contexto = { params: Promise<{ installationId: string }> };

/** GET .../outputs: salidas vivas de la instalación. */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => apiJson({ data: await listOutputsAs(actor, actor.tenantId, installationId) }));
}
