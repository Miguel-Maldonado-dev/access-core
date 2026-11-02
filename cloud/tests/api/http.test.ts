import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GET as getMe } from "@/app/api/v1/me/route";
import { apiJson, apiRoute, limits, readApiBody } from "@/lib/api/http";
import { HttpError } from "@/lib/errors";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Núcleo HTTP de la API pública contra el Supabase LOCAL: autenticación Bearer, límite de
// peticiones, Idempotency-Key y errores `{code, message}`. Cada corrida crea su tenant y
// sus llaves y los borra al final.

// Permite simular una llave que se borra entre la verificación y la lectura de `/me`.
const simulacion = vi.hoisted(() => ({ keyIdBorrada: null as string | null }));
vi.mock("@/lib/api/keys", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/keys")>();
  return {
    ...original,
    verifyApiKey: async (secret: string) => {
      const actor = await original.verifyApiKey(secret);
      return actor && simulacion.keyIdBorrada ? { ...actor, keyId: simulacion.keyIdBorrada } : actor;
    },
  };
});

const URL_BASE = "http://localhost/api/v1";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// La huella que guarda la idempotencia: HMAC con la clave derivada de PIN_LOOKUP_KEY.
const huella = (s: string) => {
  const clave = createHmac("sha256", Buffer.from(process.env.PIN_LOOKUP_KEY!, "base64"))
    .update("api-idempotency")
    .digest();
  return createHmac("sha256", clave).update(s).digest("hex");
};

interface LlavePrueba {
  id: string;
  secret: string;
}

function peticion(ruta: string, opciones: { secret?: string; method?: string; body?: unknown; idem?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opciones.secret !== undefined) headers.authorization = `Bearer ${opciones.secret}`;
  if (opciones.idem !== undefined) headers["idempotency-key"] = opciones.idem;
  let body: string | undefined;
  if (opciones.body !== undefined) {
    headers["content-type"] = "application/json";
    body = typeof opciones.body === "string" ? opciones.body : JSON.stringify(opciones.body);
  }
  return new Request(`${URL_BASE}/${ruta}`, { method: opciones.method ?? "GET", headers, body });
}

describe("núcleo HTTP de la API pública", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  let tenantId: string;
  const claveLookupOriginal = process.env.PIN_LOOKUP_KEY;

  async function llave(nombre: string, revocada = false): Promise<LlavePrueba> {
    const secret = `acc_${randomBytes(32).toString("base64url")}`;
    const { data, error } = await admin
      .from("api_keys")
      .insert({
        tenant_id: tenantId,
        name: nombre,
        prefix: secret.slice(0, 12),
        key_hash: sha256(secret),
        revoked_at: revocada ? new Date().toISOString() : null,
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return { id: data.id, secret };
  }

  // Handler de prueba para escrituras: cuenta sus ejecuciones y responde según el cuerpo.
  let ejecuciones = 0;
  const esquema = z.strictObject({ valor: z.number().int(), estado: z.number().int().optional() });
  function postPrueba(req: Request) {
    return apiRoute(req, async (actor) => {
      ejecuciones += 1;
      const cuerpo = await readApiBody(req, esquema);
      if (cuerpo.estado === 404) throw new HttpError(404, "El recurso no existe.");
      if (cuerpo.estado === 500) throw new Error("falla simulada");
      // jsonb rechaza \u0000: guardar esta respuesta en api_idempotency falla.
      if (cuerpo.estado === 999) return apiJson({ data: { texto: "a\u0000b" } }, 201);
      return apiJson({ data: { valor: cuerpo.valor, tenant_id: actor.tenantId, n: ejecuciones } }, 201);
    });
  }

  beforeAll(async () => {
    requireLocalSupabase();
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");
    const { data, error } = await admin.from("tenants").insert({ name: `API http ${sufijo}` }).select("id").single();
    if (error) throw error;
    tenantId = data.id;
  });

  afterAll(async () => {
    await admin.from("tenants").delete().eq("id", tenantId);
    if (claveLookupOriginal === undefined) delete process.env.PIN_LOOKUP_KEY;
    else process.env.PIN_LOOKUP_KEY = claveLookupOriginal;
  });

  describe("autenticación", () => {
    it("GET /me devuelve el tenant y la llave", async () => {
      const k = await llave("Me");
      const res = await getMe(peticion("me", { secret: k.secret }));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        tenant_id: tenantId,
        key: { id: k.id, name: "Me", prefix: k.secret.slice(0, 12) },
      });
    });

    it("sin encabezado, con llave inválida o revocada responde 401 invalid_api_key", async () => {
      const revocada = await llave("Revocada", true);
      const casos = [
        peticion("me"),
        peticion("me", { secret: "acc_no-es-una-llave" }),
        peticion("me", { secret: `acc_${randomBytes(32).toString("base64url")}` }),
        peticion("me", { secret: revocada.secret }),
        new Request(`${URL_BASE}/me`, { headers: { authorization: `Basic ${revocada.secret}` } }),
      ];
      for (const req of casos) {
        const res = await getMe(req);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ code: "invalid_api_key", message: "Llave de API inválida o revocada." });
      }
    });
  });

  it("GET /me con una llave borrada tras verificarla responde 401 invalid_api_key", async () => {
    const k = await llave("Borrada");
    simulacion.keyIdBorrada = randomUUID();
    try {
      const res = await getMe(peticion("me", { secret: k.secret }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: "invalid_api_key", message: "Llave de API inválida o revocada." });
    } finally {
      simulacion.keyIdBorrada = null;
    }
  });

  describe("límite de peticiones", () => {
    it("al pasar el límite por minuto responde 429 con Retry-After", async () => {
      const k = await llave("Límite");
      const original = limits.requestsPerMinute;
      limits.requestsPerMinute = 3;
      try {
        for (let i = 0; i < 3; i++) {
          expect((await getMe(peticion("me", { secret: k.secret }))).status).toBe(200);
        }
        const res = await getMe(peticion("me", { secret: k.secret }));
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("60");
        expect(await res.json()).toEqual({ code: "rate_limited", message: "Demasiadas peticiones; espera un momento." });
      } finally {
        limits.requestsPerMinute = original;
      }
    });

    it("borra las filas de más de un minuto de esa llave", async () => {
      const k = await llave("Limpieza");
      const viejo = new Date(Date.now() - 120_000).toISOString();
      await admin.from("api_requests").insert([{ key_id: k.id, at: viejo }, { key_id: k.id, at: viejo }]);
      expect((await getMe(peticion("me", { secret: k.secret }))).status).toBe(200);
      const { count } = await admin.from("api_requests").select("*", { count: "exact", head: true }).eq("key_id", k.id);
      expect(count).toBe(1);
    });
  });

  describe("Idempotency-Key", () => {
    it("con la misma llave y el mismo cuerpo el handler corre una sola vez", async () => {
      const k = await llave("Idem");
      const antes = ejecuciones;
      const r1 = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1 }, idem: "a-1" }));
      expect(r1.status).toBe(201);
      expect(r1.headers.get("idempotent-replayed")).toBeNull();
      const c1 = await r1.json();
      const r2 = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1 }, idem: "a-1" }));
      expect(r2.status).toBe(201);
      expect(r2.headers.get("idempotent-replayed")).toBe("true");
      expect(await r2.json()).toEqual(c1);
      expect(ejecuciones - antes).toBe(1);
    });

    it("guarda un HMAC con clave secreta del cuerpo, no su sha256 simple, y repite bien", async () => {
      const k = await llave("Huella");
      const body = JSON.stringify({ valor: 1234 });
      const antes = ejecuciones;
      const r1 = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body, idem: "hmac-1" }));
      expect(r1.status).toBe(201);
      const { data } = await admin.from("api_idempotency").select("request_hash").eq("key_id", k.id).single();
      const texto = `POST /api/v1/prueba\n${body}`;
      expect(data?.request_hash).not.toBe(sha256(texto));
      expect(data?.request_hash).toBe(huella(texto));
      const r2 = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body, idem: "hmac-1" }));
      expect(r2.status).toBe(201);
      expect(r2.headers.get("idempotent-replayed")).toBe("true");
      expect(await r2.json()).toEqual(await r1.json());
      expect(ejecuciones - antes).toBe(1);
    });

    it("sin Idempotency-Key el handler corre cada vez", async () => {
      const k = await llave("Sin idem");
      const antes = ejecuciones;
      await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1 } }));
      await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1 } }));
      expect(ejecuciones - antes).toBe(2);
    });

    it("dos peticiones simultáneas con la misma llave ejecutan el handler una sola vez", async () => {
      const k = await llave("Simultáneas");
      const antes = ejecuciones;
      const pedir = () =>
        postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 7 }, idem: "s-1" }));
      const [a, b] = await Promise.all([pedir(), pedir()]);
      expect(ejecuciones - antes).toBe(1);
      const [original, otra] = a.headers.get("idempotent-replayed") === null && a.status === 201 ? [a, b] : [b, a];
      expect(original.status).toBe(201);
      expect(original.headers.get("idempotent-replayed")).toBeNull();
      if (otra.status === 409) {
        expect(await otra.json()).toEqual({ code: "conflict", message: "La petición original sigue en curso." });
      } else {
        expect(otra.status).toBe(201);
        expect(otra.headers.get("idempotent-replayed")).toBe("true");
        expect(await otra.json()).toEqual(await original.json());
      }
    });

    it("si falla guardar la respuesta, la respuesta original llega igual", async () => {
      const k = await llave("Cierre fallido");
      const errores = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await postPrueba(
          peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1, estado: 999 }, idem: "z-1" }),
        );
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ data: { texto: "a\u0000b" } });
        expect(errores).toHaveBeenCalledWith("No se pudo guardar la respuesta idempotente:", expect.any(Object));
      } finally {
        errores.mockRestore();
      }
      const { data } = await admin.from("api_idempotency").select("status").eq("key_id", k.id);
      expect(data).toEqual([{ status: null }]);
    });

    it("con otro cuerpo responde 422 idempotency_mismatch", async () => {
      const k = await llave("Mismatch");
      await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1 }, idem: "b-1" }));
      const res = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 2 }, idem: "b-1" }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        code: "idempotency_mismatch",
        message: "La Idempotency-Key ya se usó con otra petición.",
      });
    });

    it("la misma Idempotency-Key en llaves distintas no se cruza", async () => {
      const k1 = await llave("Cruce 1");
      const k2 = await llave("Cruce 2");
      await postPrueba(peticion("prueba", { secret: k1.secret, method: "POST", body: { valor: 1 }, idem: "c-1" }));
      const res = await postPrueba(peticion("prueba", { secret: k2.secret, method: "POST", body: { valor: 2 }, idem: "c-1" }));
      expect(res.status).toBe(201);
      expect(res.headers.get("idempotent-replayed")).toBeNull();
    });

    it("un 4xx guardado se repite igual", async () => {
      const k = await llave("4xx");
      const antes = ejecuciones;
      const cuerpo = { valor: 1, estado: 404 };
      const r1 = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: cuerpo, idem: "d-1" }));
      expect(r1.status).toBe(404);
      expect(await r1.json()).toEqual({ code: "not_found", message: "El recurso no existe." });
      const r2 = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: cuerpo, idem: "d-1" }));
      expect(r2.status).toBe(404);
      expect(r2.headers.get("idempotent-replayed")).toBe("true");
      expect(await r2.json()).toEqual({ code: "not_found", message: "El recurso no existe." });
      expect(ejecuciones - antes).toBe(1);
    });

    it("un 5xx no se guarda y permite reintentar", async () => {
      const k = await llave("5xx");
      const antes = ejecuciones;
      const cuerpo = { valor: 1, estado: 500 };
      const r1 = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: cuerpo, idem: "e-1" }));
      expect(r1.status).toBe(500);
      expect(await r1.json()).toEqual({ code: "internal_error", message: "Error interno del servidor." });
      const { count } = await admin.from("api_idempotency").select("*", { count: "exact", head: true }).eq("key_id", k.id);
      expect(count).toBe(0);
      const r2 = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: cuerpo, idem: "e-1" }));
      expect(r2.status).toBe(500);
      expect(r2.headers.get("idempotent-replayed")).toBeNull();
      expect(ejecuciones - antes).toBe(2);
    });

    it("si la original sigue en curso responde 409 conflict", async () => {
      const k = await llave("En curso");
      const body = JSON.stringify({ valor: 1 });
      const { error } = await admin.from("api_idempotency").insert({
        key_id: k.id,
        idem_key: "f-1",
        request_hash: huella(`POST /api/v1/prueba\n${body}`),
      });
      if (error) throw error;
      const antes = ejecuciones;
      const res = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body, idem: "f-1" }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ code: "conflict", message: "La petición original sigue en curso." });
      expect(ejecuciones - antes).toBe(0);
    });

    it("una reserva en curso de más de 60 s se retoma", async () => {
      const k = await llave("Abandonada");
      const body = JSON.stringify({ valor: 1 });
      await admin.from("api_idempotency").insert({
        key_id: k.id,
        idem_key: "g-1",
        request_hash: huella(`POST /api/v1/prueba\n${body}`),
        created_at: new Date(Date.now() - 120_000).toISOString(),
      });
      const res = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body, idem: "g-1" }));
      expect(res.status).toBe(201);
    });

    it("borra las filas de más de 24 h de esa llave", async () => {
      const k = await llave("Caducas");
      await admin.from("api_idempotency").insert({
        key_id: k.id,
        idem_key: "vieja",
        request_hash: "x",
        status: 201,
        response: {},
        created_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
      });
      await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1 }, idem: "h-1" }));
      const { data } = await admin.from("api_idempotency").select("idem_key").eq("key_id", k.id);
      expect(data).toEqual([{ idem_key: "h-1" }]);
    });

    it("una Idempotency-Key de más de 200 caracteres responde 400 bad_request", async () => {
      const k = await llave("Larga");
      const res = await postPrueba(
        peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1 }, idem: "x".repeat(201) }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_request");
    });
  });

  describe("errores", () => {
    it("un cuerpo que no es JSON responde 400 bad_request", async () => {
      const k = await llave("No JSON");
      const res = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: "{no es json" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: "bad_request", message: "El cuerpo debe ser JSON válido." });
    });

    it("un campo de más responde 400 nombrando el campo", async () => {
      const k = await llave("Campo de más");
      const res = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1, extra: 2 } }));
      expect(res.status).toBe(400);
      const cuerpo = await res.json();
      expect(cuerpo.code).toBe("bad_request");
      expect(cuerpo.message).toContain("extra");
    });

    it("un HttpError(404) del handler responde {code: not_found, message}", async () => {
      const k = await llave("404");
      const res = await postPrueba(peticion("prueba", { secret: k.secret, method: "POST", body: { valor: 1, estado: 404 } }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: "not_found", message: "El recurso no existe." });
    });
  });
});
