import "server-only";
import type { Panel } from "@/lib/device/auth";
import type { CommandResult } from "@/lib/device/contract";
import { DeviceApiError } from "@/lib/device/http";
import { createAdminSupabase } from "@/lib/supabase/admin";

/** Margen extra tras `expires_at` para aceptar el resultado de un `listen_rf` (la escucha dura hasta el vencimiento). */
export const LISTEN_RF_RESULT_GRACE_MS = 15_000;

/**
 * Guarda el resultado que informa el panel de una orden de la nube (`panel_commands`).
 * Solo acepta órdenes de ESE panel: otra (o una que no existe) es 404 `not_found`.
 * - `pending` y vigente: queda `ok` o `error`, con `detail`, `reason` (solo `remote_open`),
 *   `rf_code` (solo `listen_rf`) y `finished_at`. Un `listen_rf` sigue vigente hasta
 *   `expires_at + LISTEN_RF_RESULT_GRACE_MS`.
 * - `pending` ya caducada (resultado tardío): queda `expired`; el resultado se descarta.
 * - ya terminada (resultado repetido): no cambia nada.
 * Cada escritura exige `status = 'pending'`, así que dos resultados simultáneos no se pisan.
 */
export async function recordCommandResult(panel: Panel, body: CommandResult): Promise<void> {
  const admin = createAdminSupabase();
  const { data: orden, error } = await admin
    .from("panel_commands")
    .select("id, status, kind, expires_at")
    .eq("id", body.command_id)
    .eq("panel_id", panel.id)
    .maybeSingle<{ id: string; status: string; kind: string; expires_at: string }>();
  if (error) throw error;
  if (!orden) throw new DeviceApiError(404, "not_found", "Orden no encontrada");
  if (orden.status !== "pending") return;

  const ahora = new Date();
  const margen = orden.kind === "listen_rf" ? LISTEN_RF_RESULT_GRACE_MS : 0;
  const vigente = Date.parse(orden.expires_at) + margen >= ahora.getTime();
  const cambios = vigente
    ? {
        status: body.ok ? "ok" : "error",
        detail: body.detail ?? null,
        reason: body.reason ?? null,
        rf_code: body.rf_code ?? null,
        finished_at: ahora.toISOString(),
      }
    : { status: "expired", finished_at: ahora.toISOString() };
  const { error: errorEscritura } = await admin
    .from("panel_commands")
    .update(cambios)
    .eq("id", orden.id)
    .eq("status", "pending");
  if (errorEscritura) throw errorEscritura;
}
