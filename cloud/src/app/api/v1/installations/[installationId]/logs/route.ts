import { z } from "zod";
import { apiJson, apiRoute, readApiQuery } from "@/lib/api/http";
import { SOURCE_OPTIONS, parseLogFilters } from "@/lib/log-view";
import { listLogsAs } from "@/lib/logs";

type Contexto = { params: Promise<{ installationId: string }> };

/** Día `AAAA-MM-DD` que existe en el calendario. */
const dia = z.string().refine((t) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return false;
  const [y, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(y, mes - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === mes - 1 && f.getUTCDate() === d;
});

const consultaLogs = z.strictObject({
  desde: dia.optional(),
  hasta: dia.optional(),
  panel: z.guid().optional(),
  titular: z.guid().optional(),
  resultado: z.enum(["permitido", "denegado"]).optional(),
  origen: z
    .string()
    .regex(/^\d+$/)
    .refine((t) => (SOURCE_OPTIONS as readonly number[]).includes(Number(t)))
    .optional(),
  pagina: z
    .string()
    .regex(/^\d+$/)
    .refine((t) => Number.isSafeInteger(Number(t)) && Number(t) >= 1)
    .optional(),
});

/**
 * GET .../logs?desde&hasta&panel&titular&resultado&origen&pagina: una página de 50 logs, del más
 * reciente al más viejo. Con un filtro inválido o desconocido responde 400 `bad_request`
 * (a diferencia de la interfaz, que lo ignora); ya validada la consulta, `parseLogFilters` la interpreta.
 */
export async function GET(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return apiRoute(req, async (actor) => {
    const consulta = readApiQuery(req, consultaLogs);
    const pagina = await listLogsAs(actor, actor.tenantId, installationId, parseLogFilters(consulta));
    return apiJson({ data: pagina.rows, page: pagina.page, page_size: pagina.pageSize, total: pagina.total });
  });
}
