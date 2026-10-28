import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";
import { HttpError } from "@/lib/errors";

/**
 * Respuestas y errores de la API de dispositivos (`/api/device/v1`).
 * Los errores van en JSON `{code, message}`: `code` estable para el agente del panel y
 * `message` en español. Nunca se registran credenciales ni cuerpos de petición.
 */

export class DeviceApiError extends HttpError {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super(status, message);
    this.name = "DeviceApiError";
  }
}

/** 401 genérico: no distingue panel inexistente, credencial incorrecta o estado no válido. */
export function unauthorized(): DeviceApiError {
  return new DeviceApiError(401, "unauthorized", "Credencial de dispositivo inválida.");
}

/** JSON sin caché: las respuestas pueden llevar credenciales o estado del panel. */
export function deviceJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Lee y valida el cuerpo JSON; si no es válido lanza 400 `invalid_body`. */
export async function readJsonBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let cuerpo: unknown;
  try {
    cuerpo = await req.json();
  } catch {
    throw new DeviceApiError(400, "invalid_body", "El cuerpo debe ser JSON válido.");
  }
  const resultado = schema.safeParse(cuerpo);
  if (!resultado.success) {
    const campo = resultado.error.issues[0]?.path.join(".") || "cuerpo";
    // Los rechazos propios (`refine`, p. ej. el carácter NUL) traen un mensaje claro.
    const detalle = resultado.error.issues[0]?.code === "custom" ? ` ${resultado.error.issues[0].message}` : "";
    throw new DeviceApiError(400, "invalid_body", `El cuerpo no tiene la forma esperada (campo: ${campo}).${detalle}`);
  }
  return resultado.data;
}

/**
 * Lee y valida los parámetros de la URL (`?a=1&b=2`) como un objeto de cadenas; si no
 * son válidos lanza 400 `invalid_query`.
 */
export function readQuery<T>(req: Request, schema: z.ZodType<T>): T {
  const parametros = Object.fromEntries(new URL(req.url).searchParams);
  const resultado = schema.safeParse(parametros);
  if (!resultado.success) {
    const campo = resultado.error.issues[0]?.path.join(".") || "consulta";
    throw new DeviceApiError(400, "invalid_query", `El parámetro ${campo} no es válido.`);
  }
  return resultado.data;
}

/** `code` de un `HttpError` genérico (no de dispositivo), según su estado. */
const CODIGO_POR_ESTADO: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "gone",
  429: "too_many_requests",
};

function resumenDeError(error: unknown) {
  if (error instanceof Error) {
    // Solo nombre, código y mensaje: `details` de Postgres puede traer la fila completa.
    return { name: error.name, code: (error as { code?: unknown }).code, message: error.message };
  }
  if (error && typeof error === "object" && "message" in error) {
    return { code: (error as { code?: unknown }).code, message: (error as { message: unknown }).message };
  }
  return { message: String(error) };
}

/**
 * Ejecuta un handler de la API de dispositivos y traduce sus errores a JSON.
 * `DeviceApiError` y cualquier `HttpError` responden `{code, message}` con su estado;
 * lo demás es 500. Los errores internos de Next.js (p. ej. la interrupción del
 * prerender) se relanzan.
 */
export async function deviceRoute(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof DeviceApiError) {
      return deviceJson({ code: error.code, message: error.message }, error.status);
    }
    if (error instanceof HttpError) {
      const code = CODIGO_POR_ESTADO[error.status] ?? "http_error";
      return deviceJson({ code, message: error.message }, error.status);
    }
    console.error("Error interno en la API de dispositivos:", resumenDeError(error));
    return deviceJson({ code: "internal_error", message: "Error interno del servidor." }, 500);
  }
}
