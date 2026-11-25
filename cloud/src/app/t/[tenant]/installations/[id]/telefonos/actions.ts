"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { createPhoneAs, deletePhoneAs, updatePhoneAs, type PhoneInput } from "@/lib/phones";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server actions de la pestaña Teléfonos: envoltorios delgados de `@/lib/phones`. */

const texto = z.string();

/** Crea (`phoneId` null) o edita un teléfono (número, titular y descripción). */
export async function savePhone(
  tenantId: string,
  installationId: string,
  phoneId: string | null,
  input: PhoneInput,
): Promise<ActionResult<{ id: string }>> {
  if (!z.tuple([texto, texto]).safeParse([tenantId, installationId]).success) return INVALID_DATA;
  if (phoneId !== null && typeof phoneId !== "string") return INVALID_DATA;
  return runAction(async () => {
    const supabase = await createServerSupabase();
    if (phoneId === null) return createPhoneAs(supabase, tenantId, installationId, input);
    await updatePhoneAs(supabase, tenantId, installationId, phoneId, input);
    return { id: phoneId };
  });
}

export async function deletePhone(tenantId: string, installationId: string, phoneId: string): Promise<ActionResult> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, phoneId]).success) return INVALID_DATA;
  return runAction(async () => deletePhoneAs(await createServerSupabase(), tenantId, installationId, phoneId));
}
