import "server-only";
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import type { ResultadoOperacion } from "@/lib/api/cards";
import {
  ApiError,
  apiErrorBody,
  apiJson,
  apiRoute,
  guardarIdempotencia,
  idempotencyHashes,
  idempotencyKeyValida,
  limpiarIdempotencia,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  reservarIdempotencia,
  type RespuestaGuardada,
} from "@/lib/api/http";
import { currentRevision } from "@/lib/api/revision";
import { requireInstallationAccess } from "@/lib/access-data";
import type { ApiActor } from "@/lib/auth/guards";
import { resumenDeError } from "@/lib/http-errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Lotes de la API pública: `POST .../{holders,cards,controls}/batch`.
 *
 * - Cada elemento se procesa con la MISMA operación que la ruta individual (`operaciones*`),
 *   en orden, y falla con su mismo estado, código y mensaje; un fallo no revierte a los demás.
 * - Idempotencia por elemento en el mismo espacio de llaves que `Idempotency-Key`: misma tabla
 *   (`api_idempotency`) y misma huella que la llamada individual equivalente (método, ruta y
 *   cuerpo JSON canónico).
 * - Una sola revisión y un solo aviso a los paneles: el lote se abre en la base
 *   (`api_batch_begin`); las escrituras llevan `x-acc-batch` y reciben la revisión pendiente sin
 *   avisar; `api_batch_end` la publica una vez si algo cambió (migración `api_batch`).
 * - Un lote cuenta como una petición para el límite por minuto.
 */

/** Máximo de elementos por lote (medido: ver cloud/docs/api.md). */
export const MAX_LOTE = 200;
/** Máximo de códigos en `?codes=` y `?rf_codes=`. */
export const MAX_CODIGOS = 200;
/** Vigencia del lote abierto en la base; si la función muere, caduca y se publica. */
const TTL_LOTE_S = 70;
const RETRY_AFTER_LOTE_S = "5";

export interface Operaciones {
  create(actor: ApiActor, installationId: string, json: unknown): Promise<ResultadoOperacion>;
  update(actor: ApiActor, installationId: string, id: string, json: unknown): Promise<ResultadoOperacion>;
  delete(actor: ApiActor, installationId: string, id: string): Promise<ResultadoOperacion>;
}

export interface RecursoLote {
  operaciones: Operaciones;
  /** Método de la ruta individual de `update` (PATCH en titulares y tarjetas, PUT en controles). */
  metodoUpdate: "PATCH" | "PUT";
}

const elemento = z.strictObject({
  ref: z.string().min(1).max(64),
  op: z.enum(["create", "update", "delete"]),
  id: z.unknown().optional(),
  idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH),
  data: z.unknown().optional(),
});
const cuerpoLote = z.strictObject({ items: z.array(elemento).min(1).max(MAX_LOTE) });
type Elemento = z.infer<typeof elemento>;

export type ResultadoElemento =
  | { ref: string; ok: true; id: string; data: unknown }
  | { ref: string; ok: false; status: number; code: string; message: string };

function loteInvalido(message: string): ApiError {
  return new ApiError(400, "invalid_batch", message);
}

/** Valida el lote completo; cualquier fallo es 400 `invalid_batch` y no se procesa nada. */
function validarLote(json: unknown): Elemento[] {
  const r = cuerpoLote.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0];
    const campo = issue?.path.join(".") || "cuerpo";
    if (issue?.path[0] === "items" && issue.path.length === 1 && (issue.code === "too_small" || issue.code === "too_big")) {
      throw loteInvalido(`items debe tener de 1 a ${MAX_LOTE} elementos.`);
    }
    throw loteInvalido(`El lote no tiene la forma esperada (campo: ${campo}).`);
  }
  const refs = new Set<string>();
  for (const [i, item] of r.data.items.entries()) {
    if (refs.has(item.ref)) throw loteInvalido(`El ref de items.${i} está repetido.`);
    refs.add(item.ref);
    if (!idempotencyKeyValida(item.idempotency_key)) {
      throw loteInvalido(`La idempotency_key de items.${i} no es válida.`);
    }
  }
  return r.data.items;
}

/** `?codes=` / `?rf_codes=`: enteros decimales separados por comas, de 1 a 200; si no, 400. */
export function parseCodes(texto: string, nombre: string): Set<number> {
  const partes = texto.split(",").map((p) => p.trim());
  const invalido = new ApiError(
    400,
    "bad_request",
    `El parámetro ${nombre} debe ser una lista de 1 a ${MAX_CODIGOS} códigos decimales separados por comas.`,
  );
  if (partes.length > MAX_CODIGOS || partes.some((p) => !/^\d{1,10}$/.test(p))) throw invalido;
  return new Set(partes.map(Number));
}

function resultadoDeGuardada(ref: string, idPedido: string | undefined, g: RespuestaGuardada): ResultadoElemento {
  const body = (g.body ?? {}) as { data?: { id?: unknown }; code?: unknown; message?: unknown };
  if (g.status < 400) {
    const id = typeof body.data?.id === "string" ? body.data.id : (idPedido ?? "");
    return { ref, ok: true, id, data: body.data ?? null };
  }
  return {
    ref,
    ok: false,
    status: g.status,
    code: typeof body.code === "string" ? body.code : "http_error",
    message: typeof body.message === "string" ? body.message : "",
  };
}

function fallo(ref: string, error: unknown): ResultadoElemento {
  const { status, code, message } = apiErrorBody(error);
  return { ref, ok: false, status, code, message };
}

/** Handler de `POST .../{recurso}/batch`. */
export function batchRoute(req: Request, installationId: string, recurso: RecursoLote): Promise<Response> {
  return apiRoute(req, async (actor) => {
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      throw loteInvalido("El cuerpo debe ser JSON válido.");
    }
    const items = validarLote(json);
    // 404 del lote completo si la instalación no existe o es de otro tenant.
    await requireInstallationAccess(actor, actor.tenantId, installationId, "tecnico");

    const admin = createAdminSupabase();
    const token = randomUUID();
    const { data: abierto, error: errorAbrir } = await admin.rpc("api_batch_begin", {
      p_installation_id: installationId,
      p_token: token,
      p_ttl_seconds: TTL_LOTE_S,
    });
    if (errorAbrir) throw errorAbrir;
    if (abierto !== true) {
      return apiJson(
        { code: "batch_in_progress", message: "Hay otro lote en curso en esta instalación; reintenta en unos segundos." },
        429,
        { "retry-after": RETRY_AFTER_LOTE_S },
      );
    }

    const actorLote: ApiActor = { ...actor, batchToken: token };
    const base = new URL(req.url).pathname.replace(/\/batch\/?$/, "");
    const resultados: ResultadoElemento[] = [];
    let pendiente = 0;

    /**
     * Guarda la respuesta del elemento al terminarlo (no al final del lote): si la función se
     * corta a mitad del lote, el reintento repite lo ya confirmado en lugar de reejecutarlo.
     * Un fallo al guardar no cambia el resultado (la reserva se retoma a los 60 s).
     */
    async function guardar(idemKey: string, respuesta: RespuestaGuardada | null) {
      try {
        await guardarIdempotencia(admin, actor.keyId, idemKey, respuesta);
      } catch (error) {
        console.error("No se pudo guardar la respuesta idempotente del elemento:", resumenDeError(error));
      }
    }
    let revision: number;
    try {
      await limpiarIdempotencia(admin, actor.keyId);
      // Revisión pendiente del lote: la que llevan sus filas y la que se guarda con cada éxito.
      pendiente = (await currentRevision(installationId)) + 1;
      for (const item of items) {
        resultados.push(await procesar(item));
      }
    } finally {
      revision = await cerrarLote();
    }

    async function cerrarLote(): Promise<number> {
      const { data, error } = await admin.rpc("api_batch_end", { p_installation_id: installationId, p_token: token });
      if (!error && typeof data === "number") return data;
      // El lote caduca y el trabajo `api-batches-expire` lo publica; se responde igual.
      console.error("No se pudo cerrar el lote de la API:", resumenDeError(error));
      return currentRevision(installationId);
    }

    async function procesar(item: Elemento): Promise<ResultadoElemento> {
      const { ref, op, id, data } = item;
      if (op === "create" && id !== undefined) return fallo(ref, new ApiError(400, "bad_request", "create no lleva id."));
      if (op !== "create" && typeof id !== "string") {
        return fallo(ref, new ApiError(400, "bad_request", `${op} necesita el id.`));
      }
      if (op === "delete" && data !== undefined) return fallo(ref, new ApiError(400, "bad_request", "delete no lleva data."));
      if (op !== "delete" && data === undefined) return fallo(ref, new ApiError(400, "bad_request", `${op} necesita data.`));

      const idTexto = id as string | undefined;
      const metodo = op === "create" ? "POST" : op === "update" ? recurso.metodoUpdate : "DELETE";
      const ruta = op === "create" ? base : `${base}/${idTexto}`;
      const hashes = idempotencyHashes(metodo, ruta, { json: data });

      try {
        const reserva = await reservarIdempotencia(admin, actor.keyId, item.idempotency_key, hashes);
        if (reserva.tipo === "guardada") return resultadoDeGuardada(ref, idTexto, reserva.guardada);
      } catch (error) {
        unstable_rethrow(error);
        return fallo(ref, error);
      }

      try {
        const ops = recurso.operaciones;
        const r =
          op === "create"
            ? await ops.create(actorLote, installationId, data)
            : op === "update"
              ? await ops.update(actorLote, installationId, idTexto!, data)
              : await ops.delete(actorLote, installationId, idTexto!);
        // Como la ruta individual, `{data, revision}`; la revisión es la pendiente del lote.
        await guardar(item.idempotency_key, { status: r.status, body: { data: r.data, revision: pendiente } });
        return { ref, ok: true, id: r.id, data: r.data };
      } catch (error) {
        unstable_rethrow(error);
        const res = fallo(ref, error);
        // Un 5xx libera la reserva (se puede reintentar); un 4xx se guarda y se repite.
        if (res.ok === false) {
          await guardar(item.idempotency_key, { status: res.status, body: { code: res.code, message: res.message } });
        }
        return res;
      }
    }

    return apiJson({ revision, results: resultados });
  });
}
