import { apiJson, apiRoute } from "@/lib/api/http";
import { listInstallationsAs } from "@/lib/installations";

/** GET /api/v1/installations: instalaciones del tenant de la llave, `{data: [{id, name, revision}]}`. */
export async function GET(req: Request) {
  return apiRoute(req, async (actor) => apiJson({ data: await listInstallationsAs(actor, actor.tenantId) }));
}
