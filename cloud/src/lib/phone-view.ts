/** Piezas de teléfonos compartidas por servidor y navegador. */

export const PHONE_MESSAGE = "El número debe tener 10 dígitos.";

/** Número capturado por una persona: sin espacios ni guiones, exactamente 10 dígitos; `null` si no. */
export function cleanPhone(raw: unknown): string | null {
  const limpio = typeof raw === "string" ? raw.replace(/[\s-]/g, "") : "";
  return /^[0-9]{10}$/.test(limpio) ? limpio : null;
}
