import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as loteTelefonos } from "@/app/api/v1/installations/[installationId]/phones/batch/route";
import { GET as listarTelefonos, POST as crearTelefono } from "@/app/api/v1/installations/[installationId]/phones/route";
import {
  DELETE as borrarTelefono,
  PATCH as editarTelefono,
} from "@/app/api/v1/installations/[installationId]/phones/[phoneId]/route";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Teléfonos de la API pública (individual, lote y búsqueda) contra el Supabase LOCAL.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Ctx = { params: Promise<{ installationId: string; phoneId?: string }> };
type Metodo = (req: Request, ctx: Ctx) => Promise<Response>;

describe("API pública: teléfonos", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  let instA: string;
  let instB: string;
  let secretA: string;
  let holderA: string;
  let holderB: string;
  let siguiente = Math.floor(Math.random() * 80_000_000) + 1_000_000_000;
  const numero = () => String(++siguiente);

  async function tenant(nombre: string): Promise<string> {
    const { data, error } = await admin.from("tenants").insert({ name: `PH ${nombre} ${sufijo}` }).select("id").single();
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
    opciones: { inst?: string; id?: string; body?: unknown; url?: string; secret?: string | null } = {},
  ) => {
    const { inst = instA, id = "", body, url, secret = secretA } = opciones;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) headers.authorization = `Bearer ${secret}`;
    const res = await metodo(
      new Request(url ?? `http://localhost/api/v1/installations/${inst}/phones`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ installationId: inst, phoneId: id }) },
    );
    return { res, json: await res.json() };
  };
  const revision = async () => (await admin.from("installations").select("revision").eq("id", instA).single()).data!.revision;

  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };

  beforeAll(async () => {
    requireLocalSupabase();
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");
    const tenantA = await tenant("A");
    const tenantB = await tenant("B");
    instA = await instalacion(tenantA, "Torre A");
    instB = await instalacion(tenantB, "Torre B");
    secretA = `acc_${randomBytes(32).toString("base64url")}`;
    const { error } = await admin
      .from("api_keys")
      .insert({ tenant_id: tenantA, name: "PH", prefix: secretA.slice(0, 12), key_hash: sha256(secretA) });
    if (error) throw error;
    holderA = await titular(instA, "Ana");
    holderB = await titular(instB, "Ajeno");
  });

  afterAll(async () => {
    if (claves.enc === undefined) delete process.env.PIN_ENC_KEY;
    else process.env.PIN_ENC_KEY = claves.enc;
    if (claves.lookup === undefined) delete process.env.PIN_LOOKUP_KEY;
    else process.env.PIN_LOOKUP_KEY = claves.lookup;
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
  });

  it("exige llave", async () => {
    expect((await llamar(listarTelefonos as Metodo, { secret: null })).res.status).toBe(401);
  });

  it("crear teléfono normaliza y rechaza duplicado", async () => {
    const n = numero();
    const rev = await revision();
    const { res, json } = await llamar(crearTelefono as Metodo, {
      body: { number: `${n.slice(0, 2)} ${n.slice(2, 6)}-${n.slice(6)}`, holder_id: holderA, description: "  Celular  " },
    });
    expect(res.status).toBe(201);
    expect(json.data).toMatchObject({ number: n, holder_id: holderA, holder_name: "Ana", description: "Celular" });
    expect(json.revision).toBeGreaterThan(rev);

    const dup = await llamar(crearTelefono as Metodo, { body: { number: n, holder_id: holderA } });
    expect(dup.res.status).toBe(409);
    expect(dup.json).toEqual({ code: "conflict", message: "El número ya está registrado" });

    for (const malo of ["123", "55123456789", "55123abc90", ""]) {
      const r = await llamar(crearTelefono as Metodo, { body: { number: malo, holder_id: holderA } });
      expect(r.res.status, malo).toBe(400);
      expect(r.json.message).toBe("El número debe tener 10 dígitos.");
    }
    expect((await llamar(crearTelefono as Metodo, { body: { number: numero(), holder_id: holderB } })).res.status).toBe(400);
  });

  it("PATCH, DELETE y aislamiento", async () => {
    const n = numero();
    const creado = await llamar(crearTelefono as Metodo, { body: { number: n, holder_id: holderA } });
    const id = creado.json.data.id as string;

    const vacio = await llamar(editarTelefono as Metodo, { id, body: {} });
    expect(vacio.res.status).toBe(400);
    expect(vacio.json.message).toBe("No hay cambios.");
    expect((await llamar(editarTelefono as Metodo, { id, body: { otro: 1 } })).res.status).toBe(400);

    const desc = await llamar(editarTelefono as Metodo, { id, body: { description: "Nuevo" } });
    expect(desc.json.data).toMatchObject({ id, number: n, description: "Nuevo" });
    const otro = numero();
    const cambio = await llamar(editarTelefono as Metodo, { id, body: { number: otro } });
    expect(cambio.json.data).toMatchObject({ id, number: otro, description: "Nuevo" });

    const ocupado = await llamar(crearTelefono as Metodo, { body: { number: numero(), holder_id: holderA } });
    const choque = await llamar(editarTelefono as Metodo, { id: ocupado.json.data.id, body: { number: otro } });
    expect(choque.res.status).toBe(409);
    expect(choque.json.message).toBe("El número ya está registrado");

    const ajeno = await llamar(editarTelefono as Metodo, { inst: instB, id, body: { description: "x" } });
    expect(ajeno.res.status).toBe(404);

    const del = await llamar(borrarTelefono as Metodo, { id });
    expect(del.json.data).toEqual({ id });
    expect((await llamar(borrarTelefono as Metodo, { id })).res.status).toBe(404);
    // El número queda libre tras el borrado lógico.
    expect((await llamar(crearTelefono as Metodo, { body: { number: otro, holder_id: holderA } })).res.status).toBe(201);
  });

  it("GET ?numbers= filtra y numbers inválido da 400", async () => {
    const n1 = numero();
    const n2 = numero();
    for (const n of [n1, n2]) await llamar(crearTelefono as Metodo, { body: { number: n, holder_id: holderA } });
    const url = (q: string) => `http://localhost/api/v1/installations/${instA}/phones?numbers=${q}`;
    const filtrado = await llamar(listarTelefonos as Metodo, { url: url(`${n1},5500000000`) });
    expect(filtrado.json.data.map((t: { number: string }) => t.number)).toEqual([n1]);
    const ninguno = await llamar(listarTelefonos as Metodo, { url: url("5500000001") });
    expect(ninguno.json.data).toEqual([]);
    for (const malo of ["abc", "123", `${n1},`, ""]) {
      expect((await llamar(listarTelefonos as Metodo, { url: url(malo) })).res.status, malo).toBe(400);
    }
    const todos = await llamar(listarTelefonos as Metodo, {});
    expect(todos.json.data.length).toBeGreaterThanOrEqual(2);
  });

  it("lote de teléfonos con un duplicado da 409 en ese elemento y 201 en el resto", async () => {
    const dup = numero();
    await llamar(crearTelefono as Metodo, { body: { number: dup, holder_id: holderA } });
    const nuevo1 = numero();
    const nuevo2 = numero();
    const rev = await revision();
    const { res, json } = await llamar(loteTelefonos as Metodo, {
      url: `http://localhost/api/v1/installations/${instA}/phones/batch`,
      body: {
        items: [
          { ref: "a", op: "create", idempotency_key: `k-${randomUUID()}`, data: { number: nuevo1, holder_id: holderA } },
          { ref: "b", op: "create", idempotency_key: `k-${randomUUID()}`, data: { number: dup, holder_id: holderA } },
          { ref: "c", op: "create", idempotency_key: `k-${randomUUID()}`, data: { number: nuevo2, holder_id: holderA } },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(json.results[0]).toMatchObject({ ref: "a", ok: true });
    expect(json.results[1]).toEqual({
      ref: "b",
      ok: false,
      status: 409,
      code: "conflict",
      message: "El número ya está registrado",
    });
    expect(json.results[2]).toMatchObject({ ref: "c", ok: true });
    expect(json.revision).toBe(rev + 1);

    const id = json.results[0].id as string;
    const borrado = await llamar(loteTelefonos as Metodo, {
      url: `http://localhost/api/v1/installations/${instA}/phones/batch`,
      body: { items: [{ ref: "d", op: "delete", id, idempotency_key: `k-${randomUUID()}` }] },
    });
    expect(borrado.json.results[0]).toMatchObject({ ok: true, id });
  });
});
