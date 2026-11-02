import { apiJson, apiRoute } from "@/lib/api/http";
import { HttpError } from "@/lib/errors";
import { getInstallationAs } from "@/lib/installations";
import { listPanelsAs } from "@/lib/panels/list";
import { isLinkedPanel } from "@/lib/profile-view";

type Contexto = { params: Promise<{ installationId: string }> };

/** GET .../sync-status: revisión de la instalación y si cada panel vinculado ya la aplicó. */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const instalacion = await getInstallationAs(actor, actor.tenantId, installationId);
    if (!instalacion) throw new HttpError(404, "La instalación no existe.");
    const paneles = await listPanelsAs(actor, actor.tenantId, installationId);
    return apiJson({
      data: {
        revision: instalacion.revision,
        panels: paneles.filter(isLinkedPanel).map((p) => ({
          id: p.id,
          panel_code: p.panel_code,
          online: p.online,
          synced_revision: p.synced_revision,
          applied: p.synced_revision >= instalacion.revision,
        })),
      },
    });
  });
}
