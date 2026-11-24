import { HttpError } from "@/lib/errors";

/** Límite de peticiones por minuto de una llave de API (sin dependencias del servidor: lo usa también la interfaz). */
export const DEFAULT_REQUESTS_PER_MINUTE = 120;
export const MIN_REQUESTS_PER_MINUTE = 1;
export const MAX_REQUESTS_PER_MINUTE = 5000;
export const MENSAJE_LIMITE = `Debe ser un número entre ${MIN_REQUESTS_PER_MINUTE} y ${MAX_REQUESTS_PER_MINUTE}.`;

/** Valida el límite: entero de 1 a 5000 (número o texto de solo dígitos). Si no, `HttpError` 400. */
export function parseRequestsPerMinute(valor: unknown): number {
  const n = typeof valor === "string" && /^\s*\d+\s*$/.test(valor) ? Number(valor) : valor;
  if (
    typeof n !== "number" ||
    !Number.isInteger(n) ||
    n < MIN_REQUESTS_PER_MINUTE ||
    n > MAX_REQUESTS_PER_MINUTE
  ) {
    throw new HttpError(400, MENSAJE_LIMITE);
  }
  return n;
}
