"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { updateCallSettingsAs, type CallSettingsInput } from "@/lib/call-settings";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server action de la pestaña Llamadas: envoltorio delgado de `@/lib/call-settings` (solo admin). */

const texto = z.string();

export async function saveCallSettings(
  tenantId: string,
  installationId: string,
  settingsId: string,
  input: CallSettingsInput,
): Promise<ActionResult> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, settingsId]).success) return INVALID_DATA;
  return runAction(async () =>
    updateCallSettingsAs(await createServerSupabase(), tenantId, installationId, settingsId, input),
  );
}
