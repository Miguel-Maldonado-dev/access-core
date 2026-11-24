import "server-only";
import { z } from "zod";
import { ApiError, parseApiBody } from "@/lib/api/http";
import type { ApiActor } from "@/lib/auth/guards";
import { createCardAs, deleteCardAs, getCardAs, updateCardAs } from "@/lib/cards";

/** Cuerpo de `POST .../cards`: la validación fina vive en `cards.ts`. */
export const cuerpoCrearTarjeta = z.strictObject({
  card_code: z.number(),
  holder_id: z.string(),
  description: z.string().optional(),
});

/** Cuerpo de `PATCH .../cards/{id}`: el código no se edita. */
export const cuerpoEditarTarjeta = z.strictObject({
  holder_id: z.string().optional(),
  description: z.string().optional(),
});

/** Resultado de una operación de escritura de la API: estado HTTP y `data` del cuerpo. */
export interface ResultadoOperacion {
  status: number;
  id: string;
  data: unknown;
}

/**
 * Operaciones de tarjetas de la API pública. Las usan las rutas individuales y los lotes, así
 * que un elemento de un lote falla con el mismo estado, código y mensaje que la ruta.
 */
export const operacionesTarjetas = {
  async create(actor: ApiActor, installationId: string, json: unknown): Promise<ResultadoOperacion> {
    const cuerpo = parseApiBody(json, cuerpoCrearTarjeta);
    const { id } = await createCardAs(actor, actor.tenantId, installationId, { description: "", ...cuerpo });
    return { status: 201, id, data: await getCardAs(actor, actor.tenantId, installationId, id) };
  },
  async update(actor: ApiActor, installationId: string, cardId: string, json: unknown): Promise<ResultadoOperacion> {
    const cambios = parseApiBody(json, cuerpoEditarTarjeta);
    if (Object.keys(cambios).length === 0) throw new ApiError(400, "bad_request", "No hay cambios.");
    const actual = await getCardAs(actor, actor.tenantId, installationId, cardId);
    await updateCardAs(actor, actor.tenantId, installationId, cardId, {
      holder_id: actual.holder_id,
      description: actual.description,
      ...cambios,
    });
    return { status: 200, id: cardId, data: await getCardAs(actor, actor.tenantId, installationId, cardId) };
  },
  async delete(actor: ApiActor, installationId: string, cardId: string): Promise<ResultadoOperacion> {
    await deleteCardAs(actor, actor.tenantId, installationId, cardId);
    return { status: 200, id: cardId, data: { id: cardId } };
  },
};
