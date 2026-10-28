"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { createHolderAs, deleteHolderAs, getHolderPinAs, updateHolderAs, type HolderInput } from "@/lib/holders";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions de la pestaña Titulares: envoltorios delgados de `@/lib/holders`, que valida
 * el contenido y autoriza. La página los enlaza (`bind`) con el tenant y la instalación de la URL.
 */

const ids = z.tuple([z.string(), z.string()]);

/** Crea (`holderId` null) o edita un titular. */
export async function saveHolder(
  tenantId: string,
  installationId: string,
  holderId: string | null,
  input: HolderInput,
): Promise<ActionResult<{ id: string }>> {
  if (!ids.safeParse([tenantId, installationId]).success || (holderId !== null && typeof holderId !== "string")) {
    return INVALID_DATA;
  }
  return runAction(async () => {
    const supabase = await createServerSupabase();
    if (holderId === null) return createHolderAs(supabase, tenantId, installationId, input);
    await updateHolderAs(supabase, tenantId, installationId, holderId, input);
    return { id: holderId };
  });
}

export async function deleteHolder(tenantId: string, installationId: string, holderId: string): Promise<ActionResult> {
  if (!z.tuple([z.string(), z.string(), z.string()]).safeParse([tenantId, installationId, holderId]).success) {
    return INVALID_DATA;
  }
  return runAction(async () => deleteHolderAs(await createServerSupabase(), tenantId, installationId, holderId));
}

/** PIN actual para editar: solo `admin` (403 al técnico). Nunca se manda en las listas. */
export async function revealHolderPin(
  tenantId: string,
  installationId: string,
  holderId: string,
): Promise<ActionResult<string | null>> {
  if (!z.tuple([z.string(), z.string(), z.string()]).safeParse([tenantId, installationId, holderId]).success) {
    return INVALID_DATA;
  }
  return runAction(async () => getHolderPinAs(await createServerSupabase(), tenantId, installationId, holderId));
}
