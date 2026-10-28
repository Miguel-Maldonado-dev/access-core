/**
 * Piezas compartidas por servidor y navegador para perfiles de acceso y salidas:
 * máscaras, días, horarios y mensajes (coherentes con el panel local: `weekday_mask`
 * usa el bit 0 para el lunes, igual que `datetime.weekday()` del daemon).
 */

export const MAX_PROFILES = 32;
export const MAX_PROFILES_MESSAGE = `Máximo ${MAX_PROFILES} perfiles por instalación.`;
export const NAME_MAX = 60;
export const READER_COUNT = 4;
export const OUTPUT_MAX_MS = 65535;
export const ALL_DAYS = 127;

/** Lunes primero: la posición del día es su bit en `weekday_mask`. */
export const DAY_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const;

export const DURATION_MESSAGE = `La duración debe ser un número entero de 0 a ${OUTPUT_MAX_MS} ms.`;
export const TIME_MESSAGE = "Horario inválido: usa HH:MM";

/** Regla de un perfil en un panel, tal como se guarda en `profile_panel_rules`. */
export interface RuleInput {
  output_mask: number;
  card_reader_mask: number;
  pin_reader_mask: number;
  allow_rf: boolean;
  weekday_mask: number;
  start_minute: number;
  end_minute: number;
}

export interface RuleRow extends RuleInput {
  id: string;
  profile_id: string;
  panel_id: string;
}

/** Lo que el editor manda por panel: la regla, o `null` = sin acceso en ese panel. */
export interface PanelRuleInput {
  panel_id: string;
  rule: RuleInput | null;
}

/** Panel que se muestra como columna o sección (los revocados ya no tienen reglas ni salidas editables). */
export interface PanelOption {
  id: string;
  panel_code: string;
}

export const readerLabel = (index: number) => `L${index + 1}`;

export function toMask(flags: boolean[]): number {
  return flags.reduce((mask, on, i) => (on ? mask | (1 << i) : mask), 0);
}

export function fromMask(mask: number, length: number): boolean[] {
  return Array.from({ length }, (_, i) => (mask & (1 << i)) !== 0);
}

export function minutesToHHMM(minutos: number): string {
  const h = Math.floor(minutos / 60);
  return `${String(h).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
}

const HHMM = /^(\d{2}):(\d{2})$/;

/** HH:MM → minutos del día. Lanza `Error` con el texto en español. */
export function hhmmToMinutes(texto: string): number {
  const m = HHMM.exec(texto);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h <= 23 && min <= 59) return h * 60 + min;
  }
  throw new Error(TIME_MESSAGE);
}

/** Un panel con reglas y salidas es un panel vinculado a la instalación que no fue revocado. */
export const isLinkedPanel = (p: { status: string }) => p.status !== "revoked" && p.status !== "pending";
