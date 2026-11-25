import "server-only";
import { z } from "zod";
import { ApiError, parseApiBody } from "@/lib/api/http";
import type { ResultadoOperacion } from "@/lib/api/cards";
import type { ApiActor } from "@/lib/auth/guards";
import { createPhoneAs, deletePhoneAs, getPhoneAs, updatePhoneAs } from "@/lib/phones";

/** Cuerpo de `POST .../phones`: la validación fina del número vive en `phones.ts`. */
export const cuerpoCrearTelefono = z.strictObject({
  number: z.string(),
  holder_id: z.string(),
  description: z.string().optional(),
});

/** Cuerpo de `PATCH .../phones/{id}`. */
export const cuerpoEditarTelefono = z.strictObject({
  number: z.string().optional(),
  holder_id: z.string().optional(),
  description: z.string().optional(),
});

/** Operaciones de teléfonos de la API pública, compartidas por las rutas individuales y los lotes. */
export const operacionesTelefonos = {
  async create(actor: ApiActor, installationId: string, json: unknown): Promise<ResultadoOperacion> {
    const cuerpo = parseApiBody(json, cuerpoCrearTelefono);
    const { id } = await createPhoneAs(actor, actor.tenantId, installationId, { description: "", ...cuerpo });
    return { status: 201, id, data: await getPhoneAs(actor, actor.tenantId, installationId, id) };
  },
  async update(actor: ApiActor, installationId: string, phoneId: string, json: unknown): Promise<ResultadoOperacion> {
    const cambios = parseApiBody(json, cuerpoEditarTelefono);
    if (Object.keys(cambios).length === 0) throw new ApiError(400, "bad_request", "No hay cambios.");
    const actual = await getPhoneAs(actor, actor.tenantId, installationId, phoneId);
    await updatePhoneAs(actor, actor.tenantId, installationId, phoneId, {
      number: actual.number,
      holder_id: actual.holder_id,
      description: actual.description,
      ...cambios,
    });
    return { status: 200, id: phoneId, data: await getPhoneAs(actor, actor.tenantId, installationId, phoneId) };
  },
  async delete(actor: ApiActor, installationId: string, phoneId: string): Promise<ResultadoOperacion> {
    await deletePhoneAs(actor, actor.tenantId, installationId, phoneId);
    return { status: 200, id: phoneId, data: { id: phoneId } };
  },
};
