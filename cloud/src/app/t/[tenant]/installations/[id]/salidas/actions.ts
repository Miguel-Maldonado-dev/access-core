"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { updateOutputAs, type OutputInput } from "@/lib/outputs";
import { commandStatusAs, testOutputAs, type CommandStatus } from "@/lib/panel-commands";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server actions de la pestaña Salidas: envoltorios delgados de `@/lib/outputs` y `@/lib/panel-commands`. */

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

/** "Probar" una salida: manda la orden al panel. No refresca: la página consulta el resultado. */
export async function testOutput(
  tenantId: string,
  installationId: string,
  outputId: string,
): Promise<ActionResult<{ commandId: string }>> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, outputId]).success) return INVALID_DATA;
  return runAction(async () => testOutputAs(await createServerSupabase(), tenantId, installationId, outputId), {
    refresh: false,
  });
}

/** Estado de una orden de prueba; solo consulta, así que no refresca. */
export async function commandStatus(
  tenantId: string,
  installationId: string,
  commandId: string,
): Promise<ActionResult<{ status: CommandStatus; detail: string | null }>> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, commandId]).success) return INVALID_DATA;
  return runAction(async () => commandStatusAs(await createServerSupabase(), tenantId, installationId, commandId), {
    refresh: false,
  });
}
