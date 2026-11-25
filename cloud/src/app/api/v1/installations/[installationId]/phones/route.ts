import { z } from "zod";
import { apiJson, apiRoute, readApiJson, readApiQuery } from "@/lib/api/http";
import { operacionesTelefonos } from "@/lib/api/phones";
import { parseNumbers } from "@/lib/api/batch";
import { currentRevision } from "@/lib/api/revision";
import { listPhonesAs } from "@/lib/phones";

type Contexto = { params: Promise<{ installationId: string }> };

const consulta = z.object({ numbers: z.string().optional() });

/**
 * GET .../phones: teléfonos vivos con el nombre del titular (10 dígitos). Con
 * `?numbers=5512345678,5587654321` solo los de esos números (máximo 200).
 */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { numbers } = readApiQuery(req, consulta);
    const filtro = numbers === undefined ? null : parseNumbers(numbers);
    const data = await listPhonesAs(actor, actor.tenantId, installationId);
    return apiJson({ data: filtro ? data.filter((t) => filtro.has(t.number)) : data });
  });
}

/** POST .../phones: crea un teléfono; 409 si el número ya está registrado. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const { status, data } = await operacionesTelefonos.create(actor, installationId, await readApiJson(req));
    return apiJson({ data, revision: await currentRevision(installationId) }, status);
  });
}
