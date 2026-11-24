import "server-only";
import { z } from "zod";
import type { ResultadoOperacion } from "@/lib/api/cards";
import { parseApiBody } from "@/lib/api/http";
import type { ApiActor } from "@/lib/auth/guards";
import { createControlAs, deleteControlAs, getControlAs, updateControlAs, type ControlInput } from "@/lib/controls";

/** Botón de un control: la validación fina (rangos, paneles) vive en `controls.ts`. */
const boton = z.strictObject({
  id: z.string().nullable().optional(),
  button: z.number(),
  rf_code: z.number().nullable().optional(),
  outputs: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
});

/** Cuerpo de `POST` de controles (`ControlInput`); sin `description` queda vacía. */
export const cuerpoControl = z.strictObject({
  holder_id: z.string(),
  description: z.string().optional(),
  buttons: z.array(boton),
});

/** Cuerpo de `PUT`: reemplaza la descripción, así que es obligatoria (omitirla la borraría). */
export const cuerpoControlPut = z.strictObject({ ...cuerpoControl.shape, description: z.string() });

/** Operaciones de controles de la API pública (rutas individuales y lotes). `update` es el PUT. */
export const operacionesControles = {
  async create(actor: ApiActor, installationId: string, json: unknown): Promise<ResultadoOperacion> {
    const cuerpo = parseApiBody(json, cuerpoControl);
    const { id } = await createControlAs(actor, actor.tenantId, installationId, {
      description: "",
      ...cuerpo,
    } as ControlInput);
    return { status: 201, id, data: await getControlAs(actor, actor.tenantId, installationId, id) };
  },
  async update(actor: ApiActor, installationId: string, controlId: string, json: unknown): Promise<ResultadoOperacion> {
    const cuerpo = parseApiBody(json, cuerpoControlPut);
    await updateControlAs(actor, actor.tenantId, installationId, controlId, cuerpo as ControlInput);
    return { status: 200, id: controlId, data: await getControlAs(actor, actor.tenantId, installationId, controlId) };
  },
  async delete(actor: ApiActor, installationId: string, controlId: string): Promise<ResultadoOperacion> {
    await deleteControlAs(actor, actor.tenantId, installationId, controlId);
    return { status: 200, id: controlId, data: { id: controlId } };
  },
};
