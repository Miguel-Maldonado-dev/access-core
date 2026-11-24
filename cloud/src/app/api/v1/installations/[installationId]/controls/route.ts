import { z } from "zod";
import { apiJson, apiRoute, readApiJson, readApiQuery } from "@/lib/api/http";
import { parseCodes } from "@/lib/api/batch";
import { operacionesControles } from "@/lib/api/controls";
import { currentRevision } from "@/lib/api/revision";
import { listControlsAs } from "@/lib/controls";

type Contexto = { params: Promise<{ installationId: string }> };

const consulta = z.object({ rf_codes: z.string().optional() });

/**
 * GET .../controls: controles vivos con botones y salida por panel. Con `?rf_codes=1,2` solo
 * los que tienen un botón con alguno de esos códigos (máximo 200).
 */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { rf_codes } = readApiQuery(req, consulta);
    const filtro = rf_codes === undefined ? null : parseCodes(rf_codes, "rf_codes");
    const data = await listControlsAs(actor, actor.tenantId, installationId);
    return apiJson({
      data: filtro ? data.filter((c) => c.buttons.some((b) => b.rf_code !== null && filtro.has(b.rf_code))) : data,
    });
  });
}

/** POST .../controls: crea un control; un botón sin salida en ningún panel no se crea. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { status, data } = await operacionesControles.create(actor, installationId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) }, status);
  });
}
