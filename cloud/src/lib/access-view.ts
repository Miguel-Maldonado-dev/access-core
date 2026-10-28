/**
 * Piezas compartidas por servidor y navegador para titulares, tarjetas y controles:
 * validación de códigos, etiquetas y mensajes (los mismos textos que el panel local).
 */

export type HolderKind = "persona" | "domicilio";

export const MAX_CODE = 4294967295;
export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 6;
export const BUTTON_COUNT = 4;
export const OUTPUT_COUNT = 4;

export const CODE_MESSAGE = "Usa solo números (0 a 4294967295).";
export const PIN_MESSAGE = `El PIN debe tener de ${PIN_MIN_DIGITS} a ${PIN_MAX_DIGITS} dígitos.`;

const DIGITOS = /^\d+$/;
const PIN_RE = /^\d{4,6}$/;

/** Código decimal de tarjeta o RF: 0..4294967295, solo dígitos. Lanza `Error` con el texto en español. */
export function parseCode(texto: string): number {
  const t = texto.trim();
  const n = DIGITOS.test(t) ? Number(t) : Number.NaN;
  if (!Number.isSafeInteger(n) || n > MAX_CODE) throw new Error(CODE_MESSAGE);
  return n;
}

export const isValidPin = (pin: string) => PIN_RE.test(pin);

export function holderKindLabel(kind: HolderKind): string {
  return kind === "persona" ? "Persona" : "Domicilio";
}

/** Salida del relevador como en la tabla de permisos del panel: S1..S4. */
export function outputLabel(index: number | null): string {
  return index === null ? "Sin asignar" : `S${index + 1}`;
}

function cuenta(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

export function deleteHolderMessage(h: { name: string; card_count: number; control_count: number }): string {
  const partes: string[] = [];
  if (h.card_count > 0) partes.push(cuenta(h.card_count, "tarjeta", "tarjetas"));
  if (h.control_count > 0) partes.push(cuenta(h.control_count, "control", "controles"));
  const base = `¿Borrar "${h.name}"?`;
  return partes.length === 0 ? base : `${base} También se borrarán sus ${partes.join(" y ")}.`;
}

export const cardTakenMessage = (code: number, holderName: string) =>
  `La tarjeta ${code} ya está registrada a ${holderName}.`;
export const rfTakenMessage = (code: number, holderName: string) =>
  `El código ${code} ya está registrado en un control de ${holderName}.`;
export const PIN_TAKEN_MESSAGE = "El PIN ya está asignado a otro titular.";
