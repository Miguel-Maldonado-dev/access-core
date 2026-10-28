"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { MAX_SELECTED_IDS, confirmImportAs, type ConfirmImportResult } from "@/lib/device/imports";
import { claimPanelAs, revokePanelAs, type ClaimedPanel } from "@/lib/panels/claim";
import { confirmDeletionsAs } from "@/lib/panels/deletions";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions de la pestaña Paneles. Son envoltorios delgados: la lógica, la
 * autorización y el límite de intentos están en `@/lib/panels/claim`, `@/lib/panels/deletions` y
 * `@/lib/device/imports`.
 * Devuelven un resultado en vez de lanzar (`runAction` de `@/lib/actions`), para que la
 * interfaz muestre el error.
 */

const texto = z.string().max(64);

/** Reclama un panel para la instalación con su `panel_code` y su código de vinculación. */
export async function claimPanel(
  installationId: string,
  panelCode: string,
  claimCode: string,
): Promise<ActionResult<ClaimedPanel>> {
  const datos = z.tuple([z.string(), texto, texto]).safeParse([installationId, panelCode, claimCode]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => claimPanelAs(await createServerSupabase(), ...datos.data));
}

/** Revoca la credencial de un panel; el panel vuelve a modo local. */
export async function revokePanel(panelId: string): Promise<ActionResult> {
  const datos = z.string().safeParse(panelId);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => revokePanelAs(await createServerSupabase(), datos.data));
}

/**
 * Confirma los borrados masivos de un panel (solo `admin`): durante una hora el panel
 * puede aplicar borrados que su protección había bloqueado.
 */
export async function confirmDeletions(panelId: string): Promise<ActionResult> {
  const datos = z.string().safeParse(panelId);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => confirmDeletionsAs(await createServerSupabase(), datos.data));
}

/**
 * Importa lo seleccionado de la base de un panel en revisión (solo `admin`): los IDs de
 * `onlyInPanel` que siguen siendo importables; los conflictos nunca. El panel queda activo.
 */
export async function confirmImport(
  panelId: string,
  selectedIds: string[],
): Promise<ActionResult<ConfirmImportResult>> {
  const datos = z
    .tuple([z.string(), z.array(texto).max(MAX_SELECTED_IDS)])
    .safeParse([panelId, selectedIds]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => confirmImportAs(await createServerSupabase(), ...datos.data));
}
