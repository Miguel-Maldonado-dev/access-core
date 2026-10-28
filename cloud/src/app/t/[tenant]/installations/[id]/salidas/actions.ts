"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { updateOutputAs, type OutputInput } from "@/lib/outputs";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server action de la pestaña Salidas: envoltorio delgado de `@/lib/outputs`. */

const texto = z.string();

export async function saveOutput(
  tenantId: string,
  installationId: string,
  outputId: string,
  input: OutputInput,
): Promise<ActionResult> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, outputId]).success) return INVALID_DATA;
  return runAction(async () => updateOutputAs(await createServerSupabase(), tenantId, installationId, outputId, input));
}
