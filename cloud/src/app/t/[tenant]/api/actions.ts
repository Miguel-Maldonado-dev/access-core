"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { createApiKeyAs, revokeApiKeyAs, rotateApiKeyAs, type CreatedApiKey } from "@/lib/api/keys";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions de /t/[tenant]/api (solo `admin` del tenant). Envoltorios delgados: la
 * autorización y la lógica están en `@/lib/api/keys`. El secreto viaja solo en el resultado.
 */

const texto = z.string().max(320);

/** Crea una llave; devuelve su secreto, que no se podrá volver a ver. */
export async function createApiKey(tenantId: string, name: string): Promise<ActionResult<CreatedApiKey>> {
  const datos = z.tuple([texto, texto]).safeParse([tenantId, name]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => createApiKeyAs(await createServerSupabase(), ...datos.data));
}

/** Revoca una llave. */
export async function revokeApiKey(tenantId: string, keyId: string): Promise<ActionResult<void>> {
  const datos = z.tuple([texto, texto]).safeParse([tenantId, keyId]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => {
    await revokeApiKeyAs(await createServerSupabase(), ...datos.data);
  });
}

/** Rota una llave: la anterior deja de valer y se devuelve el secreto de la nueva. */
export async function rotateApiKey(tenantId: string, keyId: string): Promise<ActionResult<CreatedApiKey>> {
  const datos = z.tuple([texto, texto]).safeParse([tenantId, keyId]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => rotateApiKeyAs(await createServerSupabase(), ...datos.data));
}
