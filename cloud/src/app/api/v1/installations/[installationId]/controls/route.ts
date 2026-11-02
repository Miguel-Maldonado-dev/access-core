import { apiJson, apiRoute, readApiBody } from "@/lib/api/http";
import { cuerpoControl } from "@/lib/api/controls";
import { currentRevision } from "@/lib/api/revision";
import { createControlAs, getControlAs, listControlsAs, type ControlInput } from "@/lib/controls";

type Contexto = { params: Promise<{ installationId: string }> };

/** GET .../controls: controles vivos con botones y salida por panel. */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    return apiJson({ data: await listControlsAs(actor, actor.tenantId, installationId) });
  });
}

/** POST .../controls: crea un control; un botón sin salida en ningún panel no se crea. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const cuerpo = await readApiBody(req, cuerpoControl);
    const { id } = await createControlAs(actor, actor.tenantId, installationId, {
      description: "",
      ...cuerpo,
    } as ControlInput);
    const data = await getControlAs(actor, actor.tenantId, installationId, id);
    return apiJson({ data, revision: await currentRevision(installationId) }, 201);
  });
}
