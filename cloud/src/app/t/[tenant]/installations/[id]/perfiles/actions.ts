"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import type { PanelRuleInput } from "@/lib/profile-view";
import {
  createProfileAs,
  deleteProfileAs,
  renameProfileAs,
  saveProfileRulesAs,
  setProfileHoldersAs,
} from "@/lib/profiles";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions de la pestaña Perfiles: envoltorios delgados de `@/lib/profiles`, que valida
 * el contenido y autoriza. La página los enlaza (`bind`) con el tenant y la instalación de la URL.
 */

const texto = z.string();
const base = z.tuple([texto, texto]);

export async function createProfile(
  tenantId: string,
  installationId: string,
  name: string,
): Promise<ActionResult<{ id: string }>> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, name]).success) return INVALID_DATA;
  return runAction(async () => {
    const { id } = await createProfileAs(await createServerSupabase(), tenantId, installationId, name);
    return { id };
  });
}

export async function renameProfile(
  tenantId: string,
  installationId: string,
  profileId: string,
  name: string,
): Promise<ActionResult> {
  if (!z.tuple([texto, texto, texto, texto]).safeParse([tenantId, installationId, profileId, name]).success) {
    return INVALID_DATA;
  }
  return runAction(async () =>
    renameProfileAs(await createServerSupabase(), tenantId, installationId, profileId, name),
  );
}

export async function deleteProfile(tenantId: string, installationId: string, profileId: string): Promise<ActionResult> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, profileId]).success) return INVALID_DATA;
  return runAction(async () => deleteProfileAs(await createServerSupabase(), tenantId, installationId, profileId));
}

/** Reglas del perfil por panel; `rule: null` = sin acceso en ese panel. */
export async function saveProfileRules(
  tenantId: string,
  installationId: string,
  profileId: string,
  rules: PanelRuleInput[],
): Promise<ActionResult> {
  if (!base.safeParse([tenantId, installationId]).success || typeof profileId !== "string") return INVALID_DATA;
  return runAction(async () =>
    saveProfileRulesAs(await createServerSupabase(), tenantId, installationId, profileId, rules),
  );
}

/** Deja el perfil asignado exactamente a esos titulares. */
export async function setProfileHolders(
  tenantId: string,
  installationId: string,
  profileId: string,
  holderIds: string[],
): Promise<ActionResult> {
  if (!base.safeParse([tenantId, installationId]).success || typeof profileId !== "string") return INVALID_DATA;
  return runAction(async () =>
    setProfileHoldersAs(await createServerSupabase(), tenantId, installationId, profileId, holderIds),
  );
}
