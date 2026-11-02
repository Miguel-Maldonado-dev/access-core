import { randomInt } from "node:crypto";

/** PIN aleatorio de 6 dígitos (con ceros a la izquierda). */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
