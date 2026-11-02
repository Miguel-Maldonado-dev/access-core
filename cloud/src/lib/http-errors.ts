import "server-only";

/**
 * Utilidades compartidas por las APIs JSON (`/api/device/v1` y `/api/v1`) para traducir
 * errores a `{code, message}` y registrarlos sin datos sensibles.
 */

/** `code` de un `HttpError` genérico, según su estado. */
export const CODIGO_POR_ESTADO: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "gone",
  429: "too_many_requests",
};

/** Resumen apto para `console.error`: solo nombre, código y mensaje. */
export function resumenDeError(error: unknown) {
  if (error instanceof Error) {
    // Solo nombre, código y mensaje: `details` de Postgres puede traer la fila completa.
    return { name: error.name, code: (error as { code?: unknown }).code, message: error.message };
  }
  if (error && typeof error === "object" && "message" in error) {
    return { code: (error as { code?: unknown }).code, message: (error as { message: unknown }).message };
  }
  return { message: String(error) };
}
