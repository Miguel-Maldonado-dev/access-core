import "server-only";
import { z } from "zod";
import type { ApiActor } from "@/lib/auth/guards";
import type { ResultadoOperacion } from "@/lib/api/cards";
import { ApiError, parseApiBody } from "@/lib/api/http";
import {
  createHolderAs,
  deleteHolderAs,
  getHolderAs,
  updateHolderAs,
  type HolderInput,
  type HolderRow,
} from "@/lib/holders";

/** Campos de un titular en la API (sin PIN; la validación fina vive en `holders.ts`). */
const campos = {
  kind: z.string(),
  name: z.string(),
  department: z.string(),
  address: z.string(),
  notes: z.string(),
};

/** Cuerpo de `POST`: tipo y nombre obligatorios. */
export const cuerpoCrearTitular = z.strictObject({
  kind: campos.kind,
  name: campos.name,
  department: campos.department.optional(),
  address: campos.address.optional(),
  notes: campos.notes.optional(),
});

/** Cuerpo de `PATCH`: cualquier subconjunto de campos. */
export const cuerpoEditarTitular = z.strictObject({
  kind: campos.kind.optional(),
  name: campos.name.optional(),
  department: campos.department.optional(),
  address: campos.address.optional(),
  notes: campos.notes.optional(),
});

/** Titular vivo de la instalación; 404 si no existe o es de otra instalación. */
export async function findHolder(actor: ApiActor, installationId: string, holderId: string): Promise<HolderRow> {
  return getHolderAs(actor, actor.tenantId, installationId, holderId);
}

/** Datos actuales del titular como `HolderInput` (sin tocar el PIN), para combinar con cambios. */
export function entradaDe(titular: HolderRow, cambios: Partial<Omit<HolderInput, "pin">> = {}): HolderInput {
  return {
    kind: titular.kind,
    name: titular.name,
    department: titular.department,
    address: titular.address,
    notes: titular.notes,
    ...cambios,
    pin: { mode: "keep" },
  };
}

/** Operaciones de titulares de la API pública (rutas individuales y lotes). */
export const operacionesTitulares = {
  async create(actor: ApiActor, installationId: string, json: unknown): Promise<ResultadoOperacion> {
    const cuerpo = parseApiBody(json, cuerpoCrearTitular);
    const entrada = { department: "", address: "", notes: "", ...cuerpo, pin: { mode: "keep" } } as HolderInput;
    const { id } = await createHolderAs(actor, actor.tenantId, installationId, entrada);
    return { status: 201, id, data: await findHolder(actor, installationId, id) };
  },
  async update(actor: ApiActor, installationId: string, holderId: string, json: unknown): Promise<ResultadoOperacion> {
    const cambios = parseApiBody(json, cuerpoEditarTitular);
    if (Object.keys(cambios).length === 0) throw new ApiError(400, "bad_request", "No hay cambios.");
    const actual = await findHolder(actor, installationId, holderId);
    await updateHolderAs(
      actor,
      actor.tenantId,
      installationId,
      holderId,
      entradaDe(actual, cambios as Partial<Omit<HolderInput, "pin">>),
    );
    return { status: 200, id: holderId, data: await findHolder(actor, installationId, holderId) };
  },
  async delete(actor: ApiActor, installationId: string, holderId: string): Promise<ResultadoOperacion> {
    await deleteHolderAs(actor, actor.tenantId, installationId, holderId);
    return { status: 200, id: holderId, data: { id: holderId } };
  },
};
