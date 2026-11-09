import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireInstallationAccess } from "@/lib/access-data";
import { HttpError } from "@/lib/errors";
import { publishToPanel } from "@/lib/mqtt/publish";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Borrado de los logs de una instalación (solo admin). Exige escribir el nombre de la
 * instalación; el borrado, la marca `logs_cleared_at` y la bitácora `log_purges` los hace la
 * función `purge_installation_logs` en una transacción, con la llave secreta.
 */

/**
 * Borra todos los logs de la instalación y avisa a los paneles activos (`{type: "sync"}` sin
 * revisión: se sincronizan ya). `confirmName` (recortado) debe ser igual al nombre de la
 * instalación, con mayúsculas; si no, 400. Un aviso que falla solo se registra en el log.
 */
export async function purgeInstallationLogsAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  confirmName: string,
): Promise<{ deleted: number }> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "admin");

  const { data: instalacion, error: errorNombre } = await acceso.supabase
    .from("installations")
    .select("name")
    .eq("id", installationId)
    .eq("tenant_id", tenantId)
    .maybeSingle<{ name: string }>();
  if (errorNombre) throw errorNombre;
  if (!instalacion || String(confirmName).trim() !== instalacion.name) {
    throw new HttpError(400, "El nombre no coincide con la instalación.");
  }

  const { data: borrados, error } = await createAdminSupabase().rpc("purge_installation_logs", {
    p_installation: installationId,
    p_user: acceso.userId,
    p_label: acceso.email || acceso.userId,
  });
  if (error) throw error;

  const { data: paneles, error: errorPaneles } = await acceso.supabase
    .from("panels")
    .select("panel_code")
    .eq("installation_id", installationId)
    .eq("status", "active");
  if (errorPaneles) {
    console.error("No se pudo leer los paneles para avisar del borrado de logs:", errorPaneles.message);
  } else {
    const lista = paneles as { panel_code: string }[];
    const resultados = await Promise.allSettled(lista.map((p) => publishToPanel(p.panel_code, { type: "sync" })));
    resultados.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`Falló el aviso de sincronización a ${lista[i].panel_code}:`, (r.reason as Error)?.message);
      }
    });
  }
  return { deleted: Number(borrados) };
}
