import { z } from "zod";
import { HttpError } from "@/lib/errors";

/**
 * Piezas compartidas por servidor y navegador para la configuración de llamadas de un panel
 * (módulo SIM808): tipos, límites y validación. Mismas reglas y textos que la web local.
 */

export type CallMode = "single" | "menu";

export interface CallSettingsInput {
  enabled: boolean;
  mode: CallMode;
  /** Salida que abre en "Una salida" (0–3). */
  output_index: number;
  /** Salidas elegibles en "Varias salidas": bit n = salida n (0–15). */
  menu_mask: number;
  /** Salida del menú que abre sin tecla; `null` = no abre sin tecla. */
  default_output: number | null;
  /** Aperturas por minuto por número (1–20). */
  call_limit_per_minute: number;
}

export interface CallSettingsRow extends CallSettingsInput {
  id: string;
  panel_id: string;
}

export const CALL_LIMIT_MIN = 1;
export const CALL_LIMIT_MAX = 20;
export const CALL_LIMIT_DEFAULT = 3;
export const CALL_LIMIT_MESSAGE = `Las aperturas por minuto deben ser un número entero de ${CALL_LIMIT_MIN} a ${CALL_LIMIT_MAX}.`;
export const DEFAULT_OUTPUT_MESSAGE = "La salida predeterminada debe estar entre las salidas del menú.";
export const DISABLE_CALLS_CONFIRM =
  "Al desactivar el módulo de llamadas, el panel borrará sus teléfonos. Podrás volver a activarlo y la nube los enviará de nuevo. ¿Desactivar?";

const esquema = z.strictObject({
  enabled: z.boolean({ error: "Datos inválidos." }),
  mode: z.enum(["single", "menu"], { error: "El modo no es válido." }),
  output_index: z.int({ error: "La salida no es válida." }).min(0, "La salida no es válida.").max(3, "La salida no es válida."),
  menu_mask: z
    .int({ error: "Las salidas del menú no son válidas." })
    .min(0, "Las salidas del menú no son válidas.")
    .max(15, "Las salidas del menú no son válidas."),
  default_output: z
    .int({ error: "La salida predeterminada no es válida." })
    .min(0, "La salida predeterminada no es válida.")
    .max(3, "La salida predeterminada no es válida.")
    .nullable(),
  call_limit_per_minute: z
    .int({ error: CALL_LIMIT_MESSAGE })
    .min(CALL_LIMIT_MIN, CALL_LIMIT_MESSAGE)
    .max(CALL_LIMIT_MAX, CALL_LIMIT_MESSAGE),
});

/**
 * Valida la configuración (400 con texto en español). La predeterminada debe estar en el menú;
 * "Una salida" ignora menú y predeterminada, así que esta se deja en `null` si no cabe en el
 * menú guardado (la base exige la coherencia siempre).
 */
export function normalizeCallSettings(entrada: unknown): CallSettingsInput {
  const r = esquema.safeParse(entrada);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Datos inválidos.");
  const v = r.data;
  const enMenu = v.default_output !== null && ((v.menu_mask >> v.default_output) & 1) === 1;
  if (v.default_output !== null && !enMenu) {
    if (v.mode === "menu") throw new HttpError(400, DEFAULT_OUTPUT_MESSAGE);
    return { ...v, default_output: null };
  }
  return v;
}
