import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireTenantRole, requireUser } from "@/lib/auth/guards";
import { HttpError } from "@/lib/errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/** Vigencia de "Confirmar borrados" (segundos): pasada esa hora vuelve a bloquearse sola. */
export const CONFIRM_DELETIONS_WINDOW_S = 3600;

/**
 * Confirma los borrados masivos de un panel (solo `admin` del tenant): pone
 * `confirm_deletions_until = now() + CONFIRM_DELETIONS_WINDOW_S` y limpia `sync_blocked`.
 * La visibilidad se comprueba con RLS (cliente del usuario) y el rol con
 * `requireTenantRole`; la escritura va con la llave secreta porque `authenticated` no
 * escribe `panels`. Un panel que el usuario no ve (inexistente o de otro tenant) da 404.
 */
export async function confirmDeletionsAs(supabase: SupabaseClient, panelId: string): Promise<void> {
  const { supabase: cliente } = await requireUser(supabase);

  const noExiste = new HttpError(404, "El panel no existe.");
  if (!z.guid().safeParse(panelId).success) throw noExiste;
  const { data: panel, error } = await cliente
    .from("panels")
    .select("id, tenant_id")
    .eq("id", panelId)
    .maybeSingle<{ id: string; tenant_id: string }>();
  if (error) throw error;
  if (!panel) throw noExiste;

  await requireTenantRole(panel.tenant_id, "admin", cliente);

  const hasta = new Date(Date.now() + CONFIRM_DELETIONS_WINDOW_S * 1000).toISOString();
  const { error: errorEscritura } = await createAdminSupabase()
    .from("panels")
    .update({ confirm_deletions_until: hasta, sync_blocked: null })
    .eq("id", panel.id)
    .eq("tenant_id", panel.tenant_id);
  if (errorEscritura) throw errorEscritura;
}
