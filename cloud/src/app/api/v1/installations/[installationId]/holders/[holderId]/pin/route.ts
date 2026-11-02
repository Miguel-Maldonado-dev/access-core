import { z } from "zod";
import { apiJson, apiRoute, readApiBody } from "@/lib/api/http";
import { currentRevision } from "@/lib/api/revision";
import { PIN_TAKEN_MESSAGE } from "@/lib/access-view";
import { HttpError } from "@/lib/errors";
import { getHolderAs, setHolderPinAs } from "@/lib/holders";
import { generatePin } from "@/lib/pin";

type Contexto = { params: Promise<{ installationId: string; holderId: string }> };

const MAX_INTENTOS_PIN = 5;
/** Sin Idempotency-Key: guardaría el PIN (respuesta o hash del cuerpo) en api_idempotency. */
const SIN_IDEMPOTENCIA = { idempotency: false };

/** `{pin}` o `{generate: true}`, uno solo. */
const cuerpoPin = z
  .strictObject({ pin: z.string().optional(), generate: z.literal(true).optional() })
  .refine((c) => (c.pin === undefined) !== (c.generate === undefined), {
    message: "Envía pin o generate, solo uno.",
  });

/**
 * PUT .../pin: con `{pin}` fija ese PIN (`{data: {has_pin: true}}`); con `{generate: true}`
 * genera uno de 6 dígitos, reintentando hasta 5 veces si ya existe, y lo devuelve una sola vez.
 */
export async function PUT(req: Request, { params }: Contexto) {
  const { installationId, holderId } = await params;
  return apiRoute(req, async (actor) => {
    const cuerpo = await readApiBody(req, cuerpoPin);
    await getHolderAs(actor, actor.tenantId, installationId, holderId);
    const guardar = (pin: string) =>
      setHolderPinAs(actor, actor.tenantId, installationId, holderId, { mode: "set", pin });

    if (cuerpo.pin !== undefined) {
      await guardar(cuerpo.pin);
      return apiJson({ data: { has_pin: true }, revision: await currentRevision(installationId) });
    }
    for (let intento = 1; ; intento++) {
      const pin = generatePin();
      try {
        await guardar(pin);
        return apiJson({ data: { pin }, revision: await currentRevision(installationId) });
      } catch (error) {
        const repetido = error instanceof HttpError && error.status === 409 && error.message === PIN_TAKEN_MESSAGE;
        if (!repetido || intento >= MAX_INTENTOS_PIN) throw error;
      }
    }
  }, SIN_IDEMPOTENCIA);
}

/** DELETE .../pin: quita el PIN; `{data: {has_pin: false}, revision}`. */
export async function DELETE(req: Request, { params }: Contexto) {
  const { installationId, holderId } = await params;
  return apiRoute(req, async (actor) => {
    await setHolderPinAs(actor, actor.tenantId, installationId, holderId, { mode: "clear" });
    return apiJson({ data: { has_pin: false }, revision: await currentRevision(installationId) });
  }, SIN_IDEMPOTENCIA);
}
