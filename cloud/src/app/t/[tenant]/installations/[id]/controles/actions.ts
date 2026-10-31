"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { createControlAs, deleteControlAs, updateControlAs, type ControlInput } from "@/lib/controls";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server actions de la pestaña Controles: envoltorios delgados de `@/lib/controls`. */

const texto = z.string();

/** Crea (`controlId` null) o edita un control con sus botones y su salida por panel. */
export async function saveControl(
  tenantId: string,
  installationId: string,
  controlId: string | null,
  input: ControlInput,
): Promise<ActionResult<{ id: string }>> {
  if (!z.tuple([texto, texto]).safeParse([tenantId, installationId]).success) return INVALID_DATA;
  if (controlId !== null && typeof controlId !== "string") return INVALID_DATA;
  return runAction(async () => {
    const supabase = await createServerSupabase();
    if (controlId === null) return createControlAs(supabase, tenantId, installationId, input);
    await updateControlAs(supabase, tenantId, installationId, controlId, input);
    return { id: controlId };
  });
}

export async function deleteControl(tenantId: string, installationId: string, controlId: string): Promise<ActionResult> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, controlId]).success) return INVALID_DATA;
  return runAction(async () => deleteControlAs(await createServerSupabase(), tenantId, installationId, controlId));
}
