import { apiJson, apiRoute } from "@/lib/api/http";
import { listPanelsAs } from "@/lib/panels/list";

type Contexto = { params: Promise<{ installationId: string }> };

/** GET .../panels: paneles de la instalación (sin `sync_blocked` ni secretos). */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const paneles = await listPanelsAs(actor, actor.tenantId, installationId);
    return apiJson({
      data: paneles.map((p) => ({
        id: p.id,
        panel_code: p.panel_code,
        status: p.status,
        online: p.online,
        last_sync_at: p.last_sync_at,
        synced_revision: p.synced_revision,
        software_version: p.software_version,
      })),
    });
  });
}
