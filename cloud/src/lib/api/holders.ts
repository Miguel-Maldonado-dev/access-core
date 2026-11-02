import "server-only";
import { z } from "zod";
import type { ApiActor } from "@/lib/auth/guards";
import { getHolderAs, type HolderInput, type HolderRow } from "@/lib/holders";

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
