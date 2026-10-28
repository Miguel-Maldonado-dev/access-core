import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptPin, pinLookup } from "@/lib/crypto";
import type { Panel } from "@/lib/device/auth";
import { readInstallationRevision } from "@/lib/device/changes";
import type { PushItem, PushResponse, PushResult } from "@/lib/device/contract";
import { liveRow } from "@/lib/device/projection";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Subida de cambios de un panel a la nube (`POST /changes`).
 *
 * Cada cambio se aplica en su propia transacción con `public.apply_panel_change` (RPC
 * con la llave secreta), en el orden recibido: un rechazo no deshace los demás. La
 * función bloquea la instalación y hace idempotencia, LWW, unicidad, la escritura,
 * `device_changes` y `sync_conflicts` de forma atómica. Antes, aquí se ajusta el desfase
 * de reloj y se cifra el PIN; después, se calcula `current` con la proyección de N6.
 */

/** Un `updated_at` del panel más adelantado que esto se reemplaza por la hora del servidor. */
export const MAX_CLOCK_SKEW_S = 300;

/** Reintentos de un cambio cuando Postgres lo aborta por interbloqueo (40P01). */
const REINTENTOS_POR_INTERBLOQUEO = 3;

type Upsert = Extract<PushItem, { op: "upsert" }>;

/** Lo que guarda device_changes y devuelve la RPC (sin `current`). */
type ResultadoGuardado = Omit<PushResult, "change_id" | "current">;

/**
 * Ejecuta `fn` y la repite (hasta `reintentos` veces) si falla por interbloqueo
 * (`40P01`): la transacción abortada no dejó nada escrito. Otros errores se lanzan.
 */
export async function retryOnDeadlock<T>(fn: () => Promise<T>, reintentos = REINTENTOS_POR_INTERBLOQUEO): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (error) {
      const codigo = (error as { code?: unknown } | null)?.code;
      if (codigo !== "40P01" || intento >= reintentos) throw error;
    }
  }
}

/** Verdadero si `updated_at` está más de `MAX_CLOCK_SKEW_S` en el futuro. */
function isClockSkewed(updatedAt: string, now = Date.now()): boolean {
  return Date.parse(updatedAt) > now + MAX_CLOCK_SKEW_S * 1000;
}

/**
 * `data` del contrato → columnas de la nube. El PIN se cifra y se calcula su
 * `pin_lookup`; `output_id` pasa a `output_index`. permissions y holder_permissions van
 * tal cual: la función SQL los traduce al perfil y a la regla de ese panel.
 */
function cloudData(panel: Panel, item: Upsert): Record<string, unknown> {
  switch (item.table) {
    case "holders": {
      const { pin, ...resto } = item.data;
      return {
        ...resto,
        pin_ciphertext: pin === null ? null : encryptPin(pin),
        pin_lookup: pin === null ? null : pinLookup(panel.installation_id, pin),
      };
    }
    case "control_buttons":
    case "outputs": {
      const { output_id, ...resto } = item.data;
      return { ...resto, output_index: output_id };
    }
    default:
      return item.data;
  }
}

/** Versión del panel para `sync_conflicts`: el cambio tal como llegó, sin el PIN. */
function panelVersion(item: PushItem): Record<string, unknown> {
  const base = { op: item.op, updated_at: item.updated_at };
  if (item.op === "delete") return base;
  if (item.table === "holders") {
    const { pin, ...resto } = item.data;
    return { ...base, data: { ...resto, has_pin: pin !== null } };
  }
  return { ...base, data: item.data };
}

async function aplicarCambio(admin: SupabaseClient, panel: Panel, item: PushItem): Promise<ResultadoGuardado> {
  const { data, error } = await admin.rpc("apply_panel_change", {
    p_panel_id: panel.id,
    p_change_id: item.change_id,
    p_table: item.table,
    p_op: item.op,
    p_row_id: item.id,
    p_updated_at: item.updated_at,
    p_clock_skewed: isClockSkewed(item.updated_at),
    p_data: item.op === "upsert" ? cloudData(panel, item) : null,
    p_panel_version: panelVersion(item),
  });
  if (error) throw error;
  return data as ResultadoGuardado;
}

/**
 * Aplica los cambios de un panel en el orden recibido y responde
 * `{revision, results}` con `revision` = installations.revision al terminar.
 * Un `superseded` o `rejected` lleva `current`: la versión vigente de ese registro para
 * este panel, o `null` si no existe (también al repetir un change_id).
 */
export async function applyPanelChanges(panel: Panel, items: PushItem[]): Promise<PushResponse> {
  const admin = createAdminSupabase();
  const results: PushResult[] = [];
  for (const item of items) {
    const guardado = await retryOnDeadlock(() => aplicarCambio(admin, panel, item));
    const resultado: PushResult = { change_id: item.change_id, ...guardado };
    if (guardado.status !== "applied") {
      const data = await liveRow(admin, panel, item.table, item.id);
      resultado.current = data === null ? null : { data };
    }
    results.push(resultado);
  }
  return { revision: await readInstallationRevision(admin, panel.installation_id), results };
}
