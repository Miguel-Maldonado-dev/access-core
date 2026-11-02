import { apiJson, apiRoute, readApiBody } from "@/lib/api/http";
import { cuerpoReglas } from "@/lib/api/profiles";
import { currentRevision } from "@/lib/api/revision";
import { getProfileAs, saveProfileRulesAs } from "@/lib/profiles";
import type { PanelRuleInput } from "@/lib/profile-view";

type Contexto = { params: Promise<{ installationId: string; profileId: string }> };

/** PUT .../profiles/{id}/rules: guarda las reglas por panel (los paneles que no vienen no se tocan). */
export async function PUT(req: Request, { params }: Contexto) {
  const { installationId, profileId } = await params;
  return apiRoute(req, async (actor) => {
    const cuerpo = await readApiBody(req, cuerpoReglas);
    await saveProfileRulesAs(actor, actor.tenantId, installationId, profileId, cuerpo as PanelRuleInput[]);
    const data = await getProfileAs(actor, actor.tenantId, installationId, profileId);
    return apiJson({ data, revision: await currentRevision(installationId) });
  });
}
