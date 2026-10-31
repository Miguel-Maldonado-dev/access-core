import "server-only";
import type { Panel } from "@/lib/device/auth";
import type { CommandResult } from "@/lib/device/contract";
import { DeviceApiError } from "@/lib/device/http";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Guarda el resultado que informa el panel de una orden de la nube (`panel_commands`).
 * Solo acepta órdenes de ESE panel: otra (o una que no existe) es 404 `not_found`.
 * - `pending` y vigente: queda `ok` o `error`, con `detail` y `finished_at`.
 * - `pending` ya caducada (resultado tardío): queda `expired`; el resultado se descarta.
 * - ya terminada (resultado repetido): no cambia nada.
 * Cada escritura exige `status = 'pending'`, así que dos resultados simultáneos no se pisan.
 */
export async function recordCommandResult(panel: Panel, body: CommandResult): Promise<void> {
  const admin = createAdminSupabase();
  const { data: orden, error } = await admin
    .from("panel_commands")
    .select("id, status, expires_at")
    .eq("id", body.command_id)
    .eq("panel_id", panel.id)
    .maybeSingle<{ id: string; status: string; expires_at: string }>();
  if (error) throw error;
  if (!orden) throw new DeviceApiError(404, "not_found", "Orden no encontrada");
  if (orden.status !== "pending") return;

  const ahora = new Date();
  const vigente = Date.parse(orden.expires_at) >= ahora.getTime();
  const cambios = vigente
    ? { status: body.ok ? "ok" : "error", detail: body.detail ?? null, finished_at: ahora.toISOString() }
    : { status: "expired", finished_at: ahora.toISOString() };
  const { error: errorEscritura } = await admin
    .from("panel_commands")
    .update(cambios)
    .eq("id", orden.id)
    .eq("status", "pending");
  if (errorEscritura) throw errorEscritura;
}
