"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { setQrSettingsAs, type QrSettings } from "@/lib/installations";
import { createQrCodeAs, deleteQrCodeAs, type QrCodeInput } from "@/lib/qr-codes";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server actions de la pestaña QR: envoltorios delgados de `@/lib/qr-codes` y `@/lib/installations`. */

const texto = z.string();

export async function createQrCode(
  tenantId: string,
  installationId: string,
  input: QrCodeInput,
): Promise<ActionResult<{ id: string }>> {
  if (!z.tuple([texto, texto]).safeParse([tenantId, installationId]).success) return INVALID_DATA;
  return runAction(async () => createQrCodeAs(await createServerSupabase(), tenantId, installationId, input));
}

export async function deleteQrCode(tenantId: string, installationId: string, qrId: string): Promise<ActionResult> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, qrId]).success) return INVALID_DATA;
  return runAction(async () => deleteQrCodeAs(await createServerSupabase(), tenantId, installationId, qrId));
}

/** Cambia el dígito de QR y el tope de vigentes (solo admin). */
export async function saveQrSettings(
  tenantId: string,
  installationId: string,
  settings: QrSettings,
): Promise<ActionResult> {
  if (!z.tuple([texto, texto]).safeParse([tenantId, installationId]).success) return INVALID_DATA;
  return runAction(async () => setQrSettingsAs(await createServerSupabase(), tenantId, installationId, settings));
}
