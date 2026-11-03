import { z } from "zod";
import { apiJson, apiRoute, readApiBody } from "@/lib/api/http";
import { awaitCommand, remoteOpenAs } from "@/lib/panel-commands";

/** La espera de la confirmación (hasta 8 s) más las consultas previas. */
export const maxDuration = 30;

type Contexto = { params: Promise<{ installationId: string; outputId: string }> };

const cuerpoApertura = z.strictObject({
  holder_id: z.guid(),
  // Sin caracteres de control (categoría Cc), como valida el daemon del panel.
  requested_by: z
    .string()
    .min(1)
    .max(120)
    .refine((valor) => !/\p{Cc}/u.test(valor), "No puede tener caracteres de control."),
});

/**
 * POST .../outputs/{outputId}/open: pide al panel abrir la salida a nombre del titular y
 * espera su confirmación (hasta 8 s). Responde 200 `{data: {command_id, status, reason,
 * detail}}` con `status` `opened`, `denied`, `failed` o `timeout`. Admite `Idempotency-Key`:
 * la respuesta se guarda al terminar la espera, así que una repetición da el mismo resultado.
 */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId, outputId } = await params;
  return apiRoute(req, async (actor) => {
    const cuerpo = await readApiBody(req, cuerpoApertura);
    const { commandId } = await remoteOpenAs(
      actor,
      actor.tenantId,
      installationId,
      outputId,
      cuerpo.holder_id,
      cuerpo.requested_by,
    );
    const resultado = await awaitCommand(commandId);
    return apiJson({ data: { command_id: commandId, ...resultado } });
  });
}
