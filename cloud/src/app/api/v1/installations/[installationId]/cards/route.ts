import { z } from "zod";
import { apiJson, apiRoute, readApiJson, readApiQuery } from "@/lib/api/http";
import { operacionesTarjetas } from "@/lib/api/cards";
import { parseCodes } from "@/lib/api/batch";
import { currentRevision } from "@/lib/api/revision";
import { listCardsAs } from "@/lib/cards";

type Contexto = { params: Promise<{ installationId: string }> };

const consulta = z.object({ codes: z.string().optional() });

/**
 * GET .../cards: tarjetas vivas con el nombre del titular (códigos en decimal). Con
 * `?codes=1,2` solo las de esos códigos (máximo 200).
 */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { codes } = readApiQuery(req, consulta);
    const filtro = codes === undefined ? null : parseCodes(codes, "codes");
    const data = await listCardsAs(actor, actor.tenantId, installationId);
    return apiJson({ data: filtro ? data.filter((c) => filtro.has(c.card_code)) : data });
  });
}

/** POST .../cards: crea una tarjeta; 409 si el código ya está registrado. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { status, data } = await operacionesTarjetas.create(actor, installationId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) }, status);
  });
}
