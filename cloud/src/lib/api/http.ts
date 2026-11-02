import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";
import { verifyApiKey } from "@/lib/api/keys";
import type { ApiActor } from "@/lib/auth/guards";
import { idempotencyHash } from "@/lib/crypto";
import { HttpError } from "@/lib/errors";
import { CODIGO_POR_ESTADO, resumenDeError } from "@/lib/http-errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Núcleo HTTP de la API pública (`/api/v1`): autenticación con `Authorization: Bearer`,
 * límite de peticiones por llave, `Idempotency-Key` y errores `{code, message}` con el
 * mensaje en español. Nunca se registran secretos ni cuerpos de petición.
 */

export class ApiError extends HttpError {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super(status, message);
    this.name = "ApiError";
  }
}

/** Límites ajustables (las pruebas bajan `requestsPerMinute`). */
export const limits = {
  /** Peticiones por llave en la ventana de 60 s. */
  requestsPerMinute: 120,
};

const VENTANA_LIMITE_MS = 60_000;
const RETRY_AFTER_S = "60";
/** Una reserva sin respuesta más vieja que esto se da por abandonada y se retoma. */
const EN_CURSO_MS = 60_000;
const DURACION_IDEMPOTENCIA_MS = 24 * 60 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY = 200;
/** Intentos de reservar una Idempotency-Key cuya fila desaparece entre inserción y lectura. */
const MAX_INTENTOS_RESERVA = 3;
const METODOS_IDEMPOTENTES = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** JSON sin caché. */
export function apiJson(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("cache-control", "no-store");
  return Response.json(body, { status, headers: h });
}

/** Lee y valida el cuerpo JSON; si no es válido lanza 400 `bad_request` nombrando el campo. */
export async function readApiBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let cuerpo: unknown;
  try {
    cuerpo = await req.json();
  } catch {
    throw new ApiError(400, "bad_request", "El cuerpo debe ser JSON válido.");
  }
  const resultado = schema.safeParse(cuerpo);
  if (!resultado.success) {
    const issue = resultado.error.issues[0];
    // Con campos de más (`strictObject`) la ruta del error es la del objeto: se nombran las llaves.
    const base = issue?.path.join(".") ?? "";
    const sobrantes = issue?.code === "unrecognized_keys" ? issue.keys.map((k) => (base ? `${base}.${k}` : k)) : [];
    const campo = sobrantes.length > 0 ? sobrantes.join(", ") : base || "cuerpo";
    const detalle =
      issue?.code === "unrecognized_keys"
        ? " Campo no permitido."
        : issue?.code === "custom"
          ? ` ${issue.message}`
          : "";
    throw new ApiError(400, "bad_request", `El cuerpo no tiene la forma esperada (campo: ${campo}).${detalle}`);
  }
  return resultado.data;
}

/** Lee y valida los parámetros de la URL como un objeto de cadenas; si no, 400 `bad_request`. */
export function readApiQuery<T>(req: Request, schema: z.ZodType<T>): T {
  const parametros = Object.fromEntries(new URL(req.url).searchParams);
  const resultado = schema.safeParse(parametros);
  if (!resultado.success) {
    const issue = resultado.error.issues[0];
    const campo =
      issue?.code === "unrecognized_keys" ? issue.keys.join(", ") : issue?.path.join(".") || "consulta";
    throw new ApiError(400, "bad_request", `El parámetro ${campo} no es válido.`);
  }
  return resultado.data;
}

function errorJson(error: unknown): Response {
  if (error instanceof ApiError) {
    return apiJson({ code: error.code, message: error.message }, error.status);
  }
  if (error instanceof HttpError) {
    const code = CODIGO_POR_ESTADO[error.status] ?? "http_error";
    return apiJson({ code, message: error.message }, error.status);
  }
  console.error("Error interno en la API pública:", resumenDeError(error));
  return apiJson({ code: "internal_error", message: "Error interno del servidor." }, 500);
}

/** 401 genérico: llave ausente, mal formada, inexistente, revocada o borrada. */
export function llaveInvalida(): ApiError {
  return new ApiError(401, "invalid_api_key", "Llave de API inválida o revocada.");
}

async function autenticar(req: Request): Promise<ApiActor> {
  const coincidencia = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  const actor = coincidencia ? await verifyApiKey(coincidencia[1]) : null;
  if (!actor) throw llaveInvalida();
  return actor;
}

/**
 * Registra la petición y cuenta las de la ventana. Contar después de insertar evita que
 * peticiones simultáneas rebasen el límite. Devuelve `false` si se rebasó.
 */
async function dentroDelLimite(admin: SupabaseClient, keyId: string): Promise<boolean> {
  const ahora = Date.now();
  const desde = new Date(ahora - VENTANA_LIMITE_MS).toISOString();

  const { error: errorLimpieza } = await admin.from("api_requests").delete().eq("key_id", keyId).lt("at", desde);
  if (errorLimpieza) throw errorLimpieza;

  const { error } = await admin.from("api_requests").insert({ key_id: keyId, at: new Date(ahora).toISOString() });
  // 23503: la llave se borró después de verificarla.
  if (error?.code === "23503") throw llaveInvalida();
  if (error) throw error;

  const { count, error: errorCuenta } = await admin
    .from("api_requests")
    .select("key_id", { count: "exact", head: true })
    .eq("key_id", keyId)
    .gte("at", desde);
  if (errorCuenta) throw errorCuenta;

  return (count ?? 0) <= limits.requestsPerMinute;
}

interface FilaIdempotencia {
  request_hash: string;
  status: number | null;
  response: unknown;
  created_at: string;
}

type Reserva = { tipo: "nueva" } | { tipo: "respuesta"; res: Response };

/**
 * Reserva `(llave, idemKey)` con `status` nulo. Si ya existía, decide: repetir la respuesta
 * guardada, 422 si el hash no coincide, 409 si sigue en curso, o retomar una reserva
 * abandonada (más de 60 s sin respuesta).
 */
async function reservarIdempotencia(
  admin: SupabaseClient,
  keyId: string,
  idemKey: string,
  hash: string,
): Promise<Reserva> {
  const ahora = Date.now();
  const caducidad = new Date(ahora - DURACION_IDEMPOTENCIA_MS).toISOString();
  const { error: errorLimpieza } = await admin
    .from("api_idempotency")
    .delete()
    .eq("key_id", keyId)
    .lt("created_at", caducidad);
  if (errorLimpieza) throw errorLimpieza;

  // La fila puede borrarse entre la inserción y la lectura (la original respondió 5xx):
  // se reintenta hasta MAX_INTENTOS_RESERVA veces y después se responde 409.
  let fila: FilaIdempotencia | null = null;
  for (let intento = 0; intento < MAX_INTENTOS_RESERVA && !fila; intento++) {
    const { error } = await admin
      .from("api_idempotency")
      .insert({ key_id: keyId, idem_key: idemKey, request_hash: hash });
    if (!error) return { tipo: "nueva" };
    if (error.code !== "23505") throw error;

    const { data, error: errorLectura } = await admin
      .from("api_idempotency")
      .select("request_hash, status, response, created_at")
      .eq("key_id", keyId)
      .eq("idem_key", idemKey)
      .maybeSingle<FilaIdempotencia>();
    if (errorLectura) throw errorLectura;
    fila = data;
  }
  const enCurso = new ApiError(409, "conflict", "La petición original sigue en curso.");
  if (!fila) throw enCurso;

  if (fila.request_hash !== hash) {
    throw new ApiError(422, "idempotency_mismatch", "La Idempotency-Key ya se usó con otra petición.");
  }
  if (fila.status === null) {
    if (ahora - Date.parse(fila.created_at) < EN_CURSO_MS) throw enCurso;
    // Abandonada: la retoma solo quien gana la actualización condicional.
    const { data: retomada, error: errorRetomar } = await admin
      .from("api_idempotency")
      .update({ created_at: new Date(ahora).toISOString() })
      .eq("key_id", keyId)
      .eq("idem_key", idemKey)
      .is("status", null)
      .eq("created_at", fila.created_at)
      .select("idem_key");
    if (errorRetomar) throw errorRetomar;
    if (retomada.length === 0) throw enCurso;
    return { tipo: "nueva" };
  }

  const guardada = fila.response as { body: unknown } | null;
  const headers = { "idempotent-replayed": "true" };
  const res =
    guardada?.body === null || guardada?.body === undefined
      ? new Response(null, { status: fila.status, headers: { ...headers, "cache-control": "no-store" } })
      : apiJson(guardada.body, fila.status, headers);
  return { tipo: "respuesta", res };
}

/** Guarda la respuesta (no 5xx y con cuerpo JSON o vacío) o libera la reserva. */
async function cerrarIdempotencia(admin: SupabaseClient, keyId: string, idemKey: string, res: Response | null) {
  let body: unknown = undefined;
  if (res && res.status < 500) {
    const texto = await res.clone().text();
    try {
      body = texto === "" ? null : JSON.parse(texto);
    } catch {
      body = undefined;
    }
  }
  const filtro = admin.from("api_idempotency");
  const { error } =
    res && body !== undefined
      ? await filtro
          .update({ status: res.status, response: { body } })
          .eq("key_id", keyId)
          .eq("idem_key", idemKey)
      : await filtro.delete().eq("key_id", keyId).eq("idem_key", idemKey);
  if (error) throw error;
}

/**
 * Ejecuta un handler de la API pública:
 * 1. autentica `Authorization: Bearer <secreto>` (401 `invalid_api_key`);
 * 2. aplica el límite por llave (429 `rate_limited` con `Retry-After`);
 * 3. con `Idempotency-Key` en `POST`/`PATCH`/`PUT`/`DELETE`, repite la respuesta guardada
 *    (`Idempotent-Replayed: true`), responde 422 si el cuerpo cambió o 409 si la original
 *    sigue en curso; guarda la respuesta salvo los 5xx;
 * 4. traduce `HttpError` a `{code, message}` y lo demás a 500 `internal_error`.
 * Los errores internos de Next.js se relanzan.
 *
 * Con `{ idempotency: false }` la ruta no admite `Idempotency-Key` (400 `bad_request`).
 * Es para rutas con secretos: la idempotencia guarda la respuesta en claro en
 * `api_idempotency`, y un PIN (respuesta de `generate`) quedaría ahí. Del cuerpo solo se
 * guarda un HMAC con clave secreta (`idempotencyHash`), que no permite recuperar un PIN.
 */
export async function apiRoute(
  req: Request,
  handler: (actor: ApiActor) => Promise<Response>,
  opciones: { idempotency?: boolean } = {},
): Promise<Response> {
  let reserva: { admin: SupabaseClient; keyId: string; idemKey: string } | null = null;
  try {
    const actor = await autenticar(req);
    const admin = createAdminSupabase();

    if (!(await dentroDelLimite(admin, actor.keyId))) {
      return apiJson(
        { code: "rate_limited", message: "Demasiadas peticiones; espera un momento." },
        429,
        { "retry-after": RETRY_AFTER_S },
      );
    }

    const idemKey = req.headers.get("idempotency-key");
    if (idemKey !== null && opciones.idempotency === false) {
      throw new ApiError(400, "bad_request", "Esta ruta no admite Idempotency-Key.");
    }
    if (idemKey === null || !METODOS_IDEMPOTENTES.has(req.method)) return await handler(actor);

    if (idemKey.length < 1 || idemKey.length > MAX_IDEMPOTENCY_KEY) {
      throw new ApiError(
        400,
        "bad_request",
        `La Idempotency-Key debe tener de 1 a ${MAX_IDEMPOTENCY_KEY} caracteres.`,
      );
    }
    const cuerpo = await req.clone().text();
    const hash = idempotencyHash(`${req.method} ${new URL(req.url).pathname}\n${cuerpo}`);
    const resultado = await reservarIdempotencia(admin, actor.keyId, idemKey, hash);
    if (resultado.tipo === "respuesta") return resultado.res;

    reserva = { admin, keyId: actor.keyId, idemKey };
    let res: Response;
    try {
      res = await handler(actor);
    } catch (error) {
      unstable_rethrow(error);
      res = errorJson(error);
    }
    const r = reserva;
    reserva = null;
    try {
      await cerrarIdempotencia(r.admin, r.keyId, r.idemKey, res);
    } catch (error) {
      // La escritura ya se hizo: se entrega su respuesta aunque no se haya podido guardar.
      // La reserva queda en curso y se retoma pasados 60 s.
      console.error("No se pudo guardar la respuesta idempotente:", resumenDeError(error));
    }
    return res;
  } catch (error) {
    if (reserva) {
      // Interrupción de Next.js durante el handler: se libera la reserva para permitir el reintento.
      await cerrarIdempotencia(reserva.admin, reserva.keyId, reserva.idemKey, null).catch(() => {});
    }
    unstable_rethrow(error);
    return errorJson(error);
  }
}
