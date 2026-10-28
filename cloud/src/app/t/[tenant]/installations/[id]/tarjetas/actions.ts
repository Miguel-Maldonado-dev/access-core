"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { createCardAs, deleteCardAs, updateCardAs, type CardInput } from "@/lib/cards";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server actions de la pestaña Tarjetas: envoltorios delgados de `@/lib/cards`. */

const texto = z.string();

/** Crea (`cardId` null) o edita una tarjeta; al editar solo cambian titular y descripción. */
export async function saveCard(
  tenantId: string,
  installationId: string,
  cardId: string | null,
  input: CardInput,
): Promise<ActionResult<{ id: string }>> {
  if (!z.tuple([texto, texto]).safeParse([tenantId, installationId]).success) return INVALID_DATA;
  if (cardId !== null && typeof cardId !== "string") return INVALID_DATA;
  return runAction(async () => {
    const supabase = await createServerSupabase();
    if (cardId === null) return createCardAs(supabase, tenantId, installationId, input);
    await updateCardAs(supabase, tenantId, installationId, cardId, input);
    return { id: cardId };
  });
}

export async function deleteCard(tenantId: string, installationId: string, cardId: string): Promise<ActionResult> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, cardId]).success) return INVALID_DATA;
  return runAction(async () => deleteCardAs(await createServerSupabase(), tenantId, installationId, cardId));
}
