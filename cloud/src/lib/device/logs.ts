import "server-only";
import type { z } from "zod";
import type { Panel } from "@/lib/device/auth";
import type { LogItem, alertRequestSchema } from "@/lib/device/contract";
import { createAdminSupabase } from "@/lib/supabase/admin";

/** Fuente "PIN" del log local: nunca se guardan sus dígitos. */
const SOURCE_PIN = 3;

/**
 * Guarda un lote de logs del panel. Idempotente: `on conflict (panel_id, local_log_id)
 * do nothing`. `tenant_id`, `installation_id` y `panel_id` salen del panel autenticado,
 * nunca del cuerpo. Un log de PIN se guarda con `code = null`.
 * `accepted` cuenta todos los logs recibidos (los repetidos ya estaban guardados) y
 * `last_local_log_id` es el mayor id recibido.
 */
export async function storeLogs(
  panel: Panel,
  logs: LogItem[],
): Promise<{ accepted: number; last_local_log_id: number }> {
  const filas = logs.map((l) => ({
    tenant_id: panel.tenant_id,
    installation_id: panel.installation_id,
    panel_id: panel.id,
    local_log_id: l.local_log_id,
    ts: l.timestamp,
    allowed: l.allowed,
    source: l.source,
    reason: l.reason,
    holder_id: l.holder_id ?? null,
    holder_name: l.holder_name ?? null,
    holder_kind: l.holder_kind ?? null,
    credential_label: l.credential_label ?? null,
    control_id: l.control_id ?? null,
    code: l.source === SOURCE_PIN ? null : (l.code ?? null),
    device_id: l.device_id ?? null,
    output_index: l.output_id ?? null,
  }));
  const { error } = await createAdminSupabase()
    .from("access_logs")
    .upsert(filas, { onConflict: "panel_id,local_log_id", ignoreDuplicates: true });
  if (error) throw error;
  return {
    accepted: logs.length,
    last_local_log_id: logs.reduce((mayor, l) => Math.max(mayor, l.local_log_id), 0),
  };
}

/** Guarda la alerta de borrado masivo bloqueado en `panels.sync_blocked`. */
export async function recordAlert(panel: Panel, alerta: z.infer<typeof alertRequestSchema>): Promise<void> {
  const { error } = await createAdminSupabase()
    .from("panels")
    .update({
      sync_blocked: {
        type: alerta.type,
        table: alerta.table,
        would_delete: alerta.would_delete,
        total: alerta.total,
        at: new Date().toISOString(),
      },
    })
    .eq("id", panel.id);
  if (error) throw error;
}
