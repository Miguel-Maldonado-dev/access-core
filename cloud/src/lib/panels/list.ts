import "server-only";
import { requireInstallationAccess } from "@/lib/access-data";
import type { DataClient } from "@/lib/auth/guards";
import type { PanelRow } from "@/lib/panels/view";

/** Paneles de una instalación del tenant (columnas no secretas), por código. 404 si no es del tenant. */
export async function listPanelsAs(client: DataClient, tenantId: string, installationId: string): Promise<PanelRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(client, tenantId, installationId, "tecnico");
  const { data, error } = await cliente
    .from("panels")
    .select("id, panel_code, status, online, last_sync_at, synced_revision, software_version, sync_blocked")
    .eq("installation_id", installationId)
    .order("panel_code");
  if (error) throw error;
  return data as PanelRow[];
}
