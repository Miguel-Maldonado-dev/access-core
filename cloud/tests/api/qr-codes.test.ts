import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as rutaLista from "@/app/api/v1/installations/[installationId]/qr-codes/route";
import * as rutaUno from "@/app/api/v1/installations/[installationId]/qr-codes/[qrId]/route";
import { POST as crearTarjeta } from "@/app/api/v1/installations/[installationId]/cards/route";
import { qrRange, qrStatus } from "@/lib/qr-codes";
import { setQrSettingsAs } from "@/lib/installations";
import type { ApiActor } from "@/lib/auth/guards";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Códigos QR de la API pública contra el Supabase LOCAL. `randomInt` se envuelve para forzar choques.
vi.mock("node:crypto", async (original) => {
  const real = await original<typeof import("node:crypto")>();
  return { ...real, default: real, randomInt: vi.fn(real.randomInt) };
});
const { randomInt } = await import("node:crypto");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
type Ctx = { params: Promise<{ installationId: string; qrId?: string }> };
type Metodo = (req: Request, ctx: Ctx) => Promise<Response>;

describe("qrRange y qrStatus", () => {
  it("rango por dígito", () => {
    expect(qrRange(4)).toEqual([4000000000, 4294967295]);
    expect(qrRange(1)).toEqual([1000000000, 1999999999]);
    expect(qrRange(9)).toEqual([900000000, 999999999]);
  });
  it("estado por vigencia", () => {
    const fila = { valid_from: "2026-12-01T15:00:00.000Z", valid_until: "2026-12-02T15:00:00.000Z" };
    expect(qrStatus(fila, new Date("2026-12-01T14:59:59Z"))).toBe("pending");
    expect(qrStatus(fila, new Date("2026-12-01T15:00:00Z"))).toBe("active");
    expect(qrStatus(fila, new Date("2026-12-02T15:00:00Z"))).toBe("expired");
  });
});

describe("API pública: códigos QR", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  let instA: string;
  let instB: string;
  let instTope: string;
  let tenantA: string;
  let secretA: string;
  let holderA: string;
  let holderTope: string;

  async function tenant(nombre: string): Promise<string> {
    const { data, error } = await admin.from("tenants").insert({ name: `QR ${nombre} ${sufijo}` }).select("id").single();
    if (error) throw error;
    tenants.push(data.id);
    return data.id;
  }
  async function instalacion(tenantId: string, name: string): Promise<string> {
    const { data, error } = await admin.from("installations").insert({ tenant_id: tenantId, name }).select("id").single();
    if (error) throw error;
    return data.id;
  }
  async function titular(inst: string, name: string): Promise<string> {
    const { data, error } = await admin
      .from("holders")
      .insert({ installation_id: inst, kind: "persona", name, updated_by: "prueba", origin: "cloud" })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  const llamar = async (
    metodo: Metodo,
    opciones: { inst?: string; id?: string; body?: unknown; query?: string; method?: string; headers?: Record<string, string> } = {},
  ) => {
    const { inst = instA, id = "", body, query = "", method = "POST" } = opciones;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${secretA}`, ...opciones.headers };
    const res = await metodo(
      new Request(`http://localhost/api/v1/installations/${inst}/qr-codes${id ? `/${id}` : ""}${query}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ installationId: inst, qrId: id }) },
    );
    const texto = await res.text();
    return { res, json: texto ? JSON.parse(texto) : null };
  };
  const horas = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    holder_id: holderA,
    label: "Visita",
    valid_from: horas(-1),
    valid_until: horas(24),
    ...extra,
  });

  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };

  beforeAll(async () => {
    requireLocalSupabase();
    // La huella de Idempotency-Key usa PIN_LOOKUP_KEY.
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");
    tenantA = await tenant("A");
    const tenantB = await tenant("B");
    instA = await instalacion(tenantA, "Torre A");
    instTope = await instalacion(tenantA, "Torre Tope");
    instB = await instalacion(tenantB, "Torre B");
    secretA = `acc_${randomBytes(32).toString("base64url")}`;
    const { error } = await admin
      .from("api_keys")
      .insert({ tenant_id: tenantA, name: "QR", prefix: secretA.slice(0, 12), key_hash: sha256(secretA) });
    if (error) throw error;
    holderA = await titular(instA, "Ana");
    holderTope = await titular(instTope, "Beto");
    await titular(instB, "Ajeno");
  });

  afterAll(async () => {
    if (claves.enc === undefined) delete process.env.PIN_ENC_KEY;
    else process.env.PIN_ENC_KEY = claves.enc;
    if (claves.lookup === undefined) delete process.env.PIN_LOOKUP_KEY;
    else process.env.PIN_LOOKUP_KEY = claves.lookup;
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
  });

  it("crear QR devuelve code en rango del dígito", async () => {
    await admin.from("installations").update({ qr_digit: 4 }).eq("id", instA);
    const { res, json } = await llamar(rutaLista.POST as Metodo, { body: cuerpo({ max_uses: 3 }) });
    expect(res.status).toBe(201);
    expect(json.data).toMatchObject({ holder_id: holderA, holder_name: "Ana", label: "Visita", max_uses: 3, status: "active", origin: "cloud" });
    expect(json.data.code).toBeGreaterThanOrEqual(4000000000);
    expect(json.data.code).toBeLessThanOrEqual(4294967295);
    expect(json.data).not.toHaveProperty("image");
    expect(typeof json.revision).toBe("number");
    await admin.from("installations").update({ qr_digit: 9 }).eq("id", instA);
  });

  it("vigencia con zona horaria; sin zona → 400", async () => {
    const { res, json } = await llamar(rutaLista.POST as Metodo, {
      body: cuerpo({ valid_from: "2026-12-01T09:00:00-06:00", valid_until: "2026-12-01T18:00:00-06:00" }),
    });
    expect(res.status).toBe(201);
    expect(json.data.valid_from).toBe("2026-12-01T15:00:00.000Z");
    expect(json.data.valid_until).toBe("2026-12-02T00:00:00.000Z");
    const sinZona = await llamar(rutaLista.POST as Metodo, { body: cuerpo({ valid_from: "2026-12-01T09:00:00" }) });
    expect(sinZona.res.status).toBe(400);
    expect(sinZona.json).toEqual({ code: "bad_request", message: "Las fechas deben llevar zona horaria (ISO 8601)." });
    const alReves = await llamar(rutaLista.POST as Metodo, { body: cuerpo({ valid_from: horas(2), valid_until: horas(1) }) });
    expect(alReves.res.status).toBe(422);
    expect(alReves.json).toEqual({ code: "unprocessable_entity", message: "La vigencia debe terminar después de empezar." });
    expect((await llamar(rutaLista.POST as Metodo, { body: cuerpo({ max_uses: 101 }) })).res.status).toBe(400);
    expect((await llamar(rutaLista.POST as Metodo, { body: cuerpo({ image: true }) })).res.status).toBe(400);
  });

  it("tope excedido → 422 con el texto fijo", async () => {
    await admin.from("installations").update({ qr_max_active: 1 }).eq("id", instTope);
    const primero = await llamar(rutaLista.POST as Metodo, { inst: instTope, body: cuerpo({ holder_id: holderTope }) });
    expect(primero.res.status).toBe(201);
    const segundo = await llamar(rutaLista.POST as Metodo, { inst: instTope, body: cuerpo({ holder_id: holderTope }) });
    expect(segundo.res.status).toBe(422);
    expect(segundo.json).toEqual({
      code: "unprocessable_entity",
      message: "Se alcanzó el máximo de QR vigentes de la instalación.",
    });
  });

  it("colisión 23505 reintenta; 20 choques → 503", async () => {
    const base = await llamar(rutaLista.POST as Metodo, { body: cuerpo() });
    const ocupado = base.json.data.code as number;
    vi.mocked(randomInt).mockReturnValueOnce(ocupado as never).mockReturnValueOnce(ocupado as never);
    const reintento = await llamar(rutaLista.POST as Metodo, { body: cuerpo() });
    expect(reintento.res.status).toBe(201);
    expect(reintento.json.data.code).not.toBe(ocupado);

    vi.mocked(randomInt).mockReturnValue(ocupado as never);
    try {
      const agotado = await llamar(rutaLista.POST as Metodo, { body: cuerpo() });
      expect(agotado.res.status).toBe(503);
      expect(agotado.json.message).toBe("No se pudo generar un código de QR único.");
      expect(vi.mocked(randomInt).mock.calls.length).toBeGreaterThanOrEqual(20);
    } finally {
      const real = await vi.importActual<typeof import("node:crypto")>("node:crypto");
      vi.mocked(randomInt).mockReset().mockImplementation(real.randomInt as never);
    }
  });

  it("GET ?status=active filtra; ?holder_id= y valores inválidos", async () => {
    const futuro = await llamar(rutaLista.POST as Metodo, { body: cuerpo({ valid_from: horas(48), valid_until: horas(72) }) });
    expect(futuro.json.data.status).toBe("pending");
    const activos = await llamar(rutaLista.GET as Metodo, { method: "GET", query: "?status=active" });
    expect(activos.res.status).toBe(200);
    expect(activos.json.data.length).toBeGreaterThan(0);
    expect(activos.json.data.every((q: { status: string }) => q.status === "active")).toBe(true);
    const pendientes = await llamar(rutaLista.GET as Metodo, { method: "GET", query: "?status=pending" });
    expect(pendientes.json.data.map((q: { id: string }) => q.id)).toContain(futuro.json.data.id);
    const porTitular = await llamar(rutaLista.GET as Metodo, { method: "GET", query: `?holder_id=${randomUUID()}` });
    expect(porTitular.json.data).toEqual([]);
    expect((await llamar(rutaLista.GET as Metodo, { method: "GET", query: "?status=otro" })).res.status).toBe(400);
    expect((await llamar(rutaLista.GET as Metodo, { method: "GET", query: "?holder_id=x" })).res.status).toBe(400);
  });

  it("DELETE → 204 y GET → 404; aislamiento e idempotencia", async () => {
    const llave = { "idempotency-key": `qr-${randomUUID()}` };
    const body = cuerpo();
    const creado = await llamar(rutaLista.POST as Metodo, { body, headers: llave });
    const repetido = await llamar(rutaLista.POST as Metodo, { body, headers: llave });
    expect(repetido.res.headers.get("idempotent-replayed")).toBe("true");
    expect(repetido.json.data.id).toBe(creado.json.data.id);
    const id = creado.json.data.id as string;

    const leido = await llamar(rutaUno.GET as Metodo, { id, method: "GET" });
    expect(leido.json.data).toMatchObject({ id, code: creado.json.data.code });
    expect((await llamar(rutaUno.GET as Metodo, { inst: instB, id, method: "GET" })).res.status).toBe(404);

    const borrado = await llamar(rutaUno.DELETE as Metodo, { id, method: "DELETE" });
    expect(borrado.res.status).toBe(204);
    expect(borrado.json).toBeNull();
    expect((await llamar(rutaUno.GET as Metodo, { id, method: "GET" })).res.status).toBe(404);
    expect((await llamar(rutaUno.DELETE as Metodo, { id, method: "DELETE" })).res.status).toBe(404);
  });

  it("PATCH → 405 (la ruta no exporta PATCH ni PUT)", () => {
    expect(rutaUno).not.toHaveProperty("PATCH");
    expect(rutaUno).not.toHaveProperty("PUT");
    expect(rutaLista).not.toHaveProperty("PATCH");
    expect(rutaLista).not.toHaveProperty("PUT");
  });

  it('tarjeta en rango → 422 "Ese código está reservado para QR."', async () => {
    const { res, json } = await llamar(crearTarjeta as Metodo, { body: { card_code: 950000000, holder_id: holderA } });
    expect(res.status).toBe(422);
    expect(json).toEqual({ code: "unprocessable_entity", message: "Ese código está reservado para QR." });
  });

  it('cambiar dígito con tarjetas en rango → 422 "Hay tarjetas en ese rango"', async () => {
    const tarjeta = await llamar(crearTarjeta as Metodo, { body: { card_code: 512345678, holder_id: holderA } });
    expect(tarjeta.res.status).toBe(201);
    const actor: ApiActor = { kind: "api", tenantId: tenantA, keyId: randomUUID(), keyName: "QR", requestsPerMinute: 120 };
    await expect(setQrSettingsAs(actor, tenantA, instA, { digit: 5, max_active: 1000 })).rejects.toMatchObject({
      status: 422,
      message: "Hay tarjetas en ese rango",
    });
  });
});
