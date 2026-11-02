import { apiJson, apiRoute, readApiBody } from "@/lib/api/http";
import { cuerpoCrearTarjeta } from "@/lib/api/cards";
import { currentRevision } from "@/lib/api/revision";
import { createCardAs, getCardAs, listCardsAs } from "@/lib/cards";

type Contexto = { params: Promise<{ installationId: string }> };

/** GET .../cards: tarjetas vivas con el nombre del titular (códigos en decimal). */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    return apiJson({ data: await listCardsAs(actor, actor.tenantId, installationId) });
  });
}

/** POST .../cards: crea una tarjeta; 409 si el código ya está registrado. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const cuerpo = await readApiBody(req, cuerpoCrearTarjeta);
    const { id } = await createCardAs(actor, actor.tenantId, installationId, {
      description: "",
      ...cuerpo,
    });
    const data = await getCardAs(actor, actor.tenantId, installationId, id);
    return apiJson({ data, revision: await currentRevision(installationId) }, 201);
  });
}
