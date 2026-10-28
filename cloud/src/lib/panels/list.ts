import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth/guards";
import type { PanelRow } from "@/lib/panels/view";

/** Paneles de una instalación (columnas no secretas, con RLS), por código. */
export async function listPanelsAs(supabase: SupabaseClient, installationId: string): Promise<PanelRow[]> {
  const { supabase: cliente } = await requireUser(supabase);
  const { data, error } = await cliente
    .from("panels")
    .select("id, panel_code, status, online, last_sync_at, synced_revision, software_version, sync_blocked")
    .eq("installation_id", installationId)
    .order("panel_code");
  if (error) throw error;
  return data as PanelRow[];
}
