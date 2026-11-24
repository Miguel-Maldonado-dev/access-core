"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { deleteInstallationAs } from "@/lib/installation-delete";
import { createInstallationAs, renameInstallationAs } from "@/lib/installations";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server actions de /t/[tenant]/installations: envoltorios delgados de `@/lib/installations`. */

const texto = z.string().max(500);

/** Crea una instalación (solo `admin` del tenant). */
export async function createInstallation(tenantId: string, name: string): Promise<ActionResult<{ id: string }>> {
  const datos = z.tuple([texto, texto]).safeParse([tenantId, name]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => createInstallationAs(await createServerSupabase(), ...datos.data));
}

/** Cambia el nombre de una instalación (cualquier miembro del tenant). */
export async function renameInstallation(
  tenantId: string,
  installationId: string,
  name: string,
): Promise<ActionResult> {
  const datos = z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, name]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => renameInstallationAs(await createServerSupabase(), ...datos.data));
}

/**
 * Elimina una instalación con todos sus datos en la nube (solo `admin`; exige su nombre).
 * No refresca: la página de la instalación ya no existe y el cliente redirige a la lista.
 */
export async function deleteInstallation(
  tenantId: string,
  installationId: string,
  confirmName: string,
): Promise<ActionResult> {
  const datos = z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, confirmName]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => deleteInstallationAs(await createServerSupabase(), ...datos.data), {
    refresh: false,
  });
}
