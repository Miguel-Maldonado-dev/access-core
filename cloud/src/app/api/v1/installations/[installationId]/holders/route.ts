import { apiJson, apiRoute, readApiBody } from "@/lib/api/http";
import { cuerpoCrearTitular, findHolder } from "@/lib/api/holders";
import { currentRevision } from "@/lib/api/revision";
import { createHolderAs, listHoldersAs, type HolderInput } from "@/lib/holders";

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
    const cuerpo = await readApiBody(req, cuerpoCrearTitular);
    const entrada = {
      department: "",
      address: "",
      notes: "",
      ...cuerpo,
      pin: { mode: "keep" },
    } as HolderInput;
    const { id } = await createHolderAs(actor, actor.tenantId, installationId, entrada);
    const data = await findHolder(actor, installationId, id);
    return apiJson({ data, revision: await currentRevision(installationId) }, 201);
  });
}
