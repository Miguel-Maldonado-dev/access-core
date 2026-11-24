import { apiJson, apiRoute, readApiJson } from "@/lib/api/http";
import { operacionesControles } from "@/lib/api/controls";
import { currentRevision } from "@/lib/api/revision";
import { getControlAs } from "@/lib/controls";

type Contexto = { params: Promise<{ installationId: string; controlId: string }> };

/** GET .../controls/{id}: el control; 404 si no existe o es de otra instalación o tenant. */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId, controlId } = await params;
  return apiRoute(req, async (actor) => {
    return apiJson({ data: await getControlAs(actor, actor.tenantId, installationId, controlId) });
  });
}

/** PUT .../controls/{id}: reemplaza titular, descripción y los botones enviados (los demás no se tocan). */
export async function PUT(req: Request, { params }: Contexto) {
  const { installationId, controlId } = await params;
  return apiRoute(req, async (actor) => {
    const { data } = await operacionesControles.update(actor, installationId, controlId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}

/** DELETE .../controls/{id}: borrado lógico; `{data: {id}, revision}`. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, controlId } = await params;
  return apiRoute(req, async (actor) => {
    const { data } = await operacionesControles.delete(actor, installationId, controlId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}
