import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as listar, POST as crear } from "@/app/api/v1/installations/[installationId]/holders/route";
import {
  DELETE as borrar,
  GET as leer,
  PATCH as editar,
} from "@/app/api/v1/installations/[installationId]/holders/[holderId]/route";
import { DELETE as quitarPin, PUT as ponerPin } from "@/app/api/v1/installations/[installationId]/holders/[holderId]/pin/route";
import { getHolderPinAs } from "@/lib/holders";
import { generatePin } from "@/lib/pin";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Titulares y PIN de la API pública contra el Supabase LOCAL.

vi.mock("@/lib/pin", async (original) => {
  const real = await original<typeof import("@/lib/pin")>();
  return { generatePin: vi.fn(real.generatePin) };
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Ctx = { params: Promise<{ installationId: string; holderId: string }> };
type Metodo = (req: Request, ctx: Ctx) => Promise<Response>;

describe("API pública: titulares y PIN", () => {
  const admin = localAdmin();
  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };
  const sufijo = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instB: string;
  let keyId: string;
  let secretA: string;
  let holderB: string;

  async function tenant(nombre: string): Promise<string> {
    const { data, error } = await admin.from("tenants").insert({ name: `Titulares ${nombre} ${sufijo}` }).select("id").single();
    if (error) throw error;
    tenants.push(data.id);
    return data.id;
  }
  async function instalacion(tenantId: string, name: string): Promise<string> {
    const { data, error } = await admin.from("installations").insert({ tenant_id: tenantId, name }).select("id").single();
    if (error) throw error;
    return data.id;
  }

  const pedir = (
    metodo: Metodo,
    opciones: { holder?: string; inst?: string; body?: unknown; secret?: string | null; idem?: string } = {},
  ) => {
    const { holder = "", inst = instA, body, secret = secretA, idem } = opciones;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) headers.authorization = `Bearer ${secret}`;
    if (idem !== undefined) headers["idempotency-key"] = idem;
    return metodo(
      new Request(`http://localhost/api/v1/installations/${inst}/holders`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ installationId: inst, holderId: holder }) },
    );
  };
  // Los métodos se invocan directamente; el verbo de la Request no importa para apiRoute salvo la idempotencia.
  async function crearTitular(body: unknown) {
    const res = await pedir(crear as Metodo, { body });
    return { res, json: await res.json() };
  }
  const actor = () => ({ kind: "api" as const, tenantId: tenantA, keyId, keyName: "Titulares" });
  const revision = async () => (await admin.from("installations").select("revision").eq("id", instA).single()).data!.revision;

  beforeAll(async () => {
    requireLocalSupabase();
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");
    tenantA = await tenant("A");
    tenantB = await tenant("B");
    instA = await instalacion(tenantA, "Torre A");
    instB = await instalacion(tenantB, "Torre B");
    secretA = `acc_${randomBytes(32).toString("base64url")}`;
    const { data, error } = await admin
      .from("api_keys")
      .insert({ tenant_id: tenantA, name: "Titulares", prefix: secretA.slice(0, 12), key_hash: sha256(secretA) })
      .select("id")
      .single();
    if (error) throw error;
    keyId = data.id;
    const { data: hb, error: errorB } = await admin
      .from("holders")
      .insert({ installation_id: instB, kind: "persona", name: "Ajeno", updated_by: "prueba", origin: "cloud" })
      .select("id")
      .single();
    if (errorB) throw errorB;
    holderB = hb.id;
  });

  afterAll(async () => {
    for (const [nombre, valor] of [
      ["PIN_ENC_KEY", claves.enc],
      ["PIN_LOOKUP_KEY", claves.lookup],
    ] as const) {
      if (valor === undefined) delete process.env[nombre];
      else process.env[nombre] = valor;
    }
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
  });

  afterEach(async () => {
    const real = await vi.importActual<typeof import("@/lib/pin")>("@/lib/pin");
    vi.mocked(generatePin).mockReset().mockImplementation(real.generatePin);
  });

  it("exige llave", async () => {
    expect((await pedir(listar as Metodo, { secret: null })).status).toBe(401);
  });

  it("CRUD completo: la revisión sube en cada escritura y has_pin cambia con el PIN", async () => {
    let rev = await revision();

    const { res, json } = await crearTitular({ kind: "persona", name: "  Ana  ", department: "101" });
    expect(res.status).toBe(201);
    expect(json.data).toMatchObject({ kind: "persona", name: "Ana", department: "101", address: "", notes: "", has_pin: false });
    expect(json.revision).toBeGreaterThan(rev);
    expect(json.revision).toBe(await revision());
    rev = json.revision;
    const id = json.data.id as string;

    const lista = await (await pedir(listar as Metodo)).json();
    expect(lista.data.map((h: { id: string }) => h.id)).toContain(id);
    expect(JSON.stringify(lista)).not.toMatch(/pin_ciphertext|pin_lookup/);
    expect((await (await pedir(leer as Metodo, { holder: id })).json()).data.id).toBe(id);

    const pin = await pedir(ponerPin as Metodo, { holder: id, body: { pin: "4321" } });
    expect(pin.status).toBe(200);
    const pinJson = await pin.json();
    expect(pinJson.data).toEqual({ has_pin: true });
    expect(pinJson.revision).toBeGreaterThan(rev);
    rev = pinJson.revision;
    expect((await (await pedir(leer as Metodo, { holder: id })).json()).data.has_pin).toBe(true);
    expect(await getHolderPinAs(actor(), tenantA, instA, id)).toBe("4321");

    const sinPin = await (await pedir(quitarPin as Metodo, { holder: id })).json();
    expect(sinPin.data).toEqual({ has_pin: false });
    expect(sinPin.revision).toBeGreaterThan(rev);
    rev = sinPin.revision;
    expect((await (await pedir(leer as Metodo, { holder: id })).json()).data.has_pin).toBe(false);

    const del = await (await pedir(borrar as Metodo, { holder: id })).json();
    expect(del.data).toEqual({ id });
    expect(del.revision).toBeGreaterThan(rev);
    expect((await pedir(leer as Metodo, { holder: id })).status).toBe(404);
  });

  it("generate devuelve 6 dígitos descifrables y ninguna lectura devuelve el PIN", async () => {
    const { json } = await crearTitular({ kind: "domicilio", name: "Casa 7" });
    const id = json.data.id as string;
    const res = await pedir(ponerPin as Metodo, { holder: id, body: { generate: true } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.pin).toMatch(/^\d{6}$/);
    expect(await getHolderPinAs(actor(), tenantA, instA, id)).toBe(data.pin);
    for (const r of [await pedir(leer as Metodo, { holder: id }), await pedir(listar as Metodo)]) {
      expect(await r.text()).not.toContain(data.pin);
    }
  });

  it("un PIN repetido da 409 y generate reintenta con otro", async () => {
    const a = (await crearTitular({ kind: "persona", name: "Uno" })).json.data.id as string;
    const b = (await crearTitular({ kind: "persona", name: "Dos" })).json.data.id as string;
    expect((await pedir(ponerPin as Metodo, { holder: a, body: { pin: "5555" } })).status).toBe(200);
    const dup = await pedir(ponerPin as Metodo, { holder: b, body: { pin: "5555" } });
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe("conflict");

    // generate: los dos primeros candidatos chocan con el PIN de `a`; el tercero es libre.
    // Mismo PIN de 6 dígitos para el choque: se fija primero en `a`.
    expect((await pedir(ponerPin as Metodo, { holder: a, body: { pin: "123456" } })).status).toBe(200);
    const mock = vi.mocked(generatePin);
    mock.mockReturnValueOnce("123456").mockReturnValueOnce("123456").mockReturnValueOnce("654321");
    const res = await pedir(ponerPin as Metodo, { holder: b, body: { generate: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.pin).toBe("654321");

    // Cinco choques seguidos: 409.
    mock.mockReset().mockReturnValue("123456");
    const agotado = await pedir(ponerPin as Metodo, { holder: b, body: { generate: true } });
    expect(agotado.status).toBe(409);
    expect(mock).toHaveBeenCalledTimes(5);
  });

  it("rechaza campos de más, el campo pin, cuerpos vacíos y PIN inválidos con 400", async () => {
    const extra = await crearTitular({ kind: "persona", name: "X", color: "rojo" });
    expect(extra.res.status).toBe(400);
    expect(extra.json.message).toContain("color");

    const conPin = await crearTitular({ kind: "persona", name: "X", pin: "1234" });
    expect(conPin.res.status).toBe(400);
    expect(conPin.json.message).toContain("pin");

    const id = (await crearTitular({ kind: "persona", name: "Base" })).json.data.id as string;
    const patchPin = await pedir(editar as Metodo, { holder: id, body: { pin: "1234" } });
    expect(patchPin.status).toBe(400);
    const vacio = await pedir(editar as Metodo, { holder: id, body: {} });
    expect(vacio.status).toBe(400);
    expect(await vacio.json()).toEqual({ code: "bad_request", message: "No hay cambios." });

    for (const body of [{}, { pin: "12" }, { pin: "1234", generate: true }, { generate: false }, { pin: "12a45" }]) {
      expect((await pedir(ponerPin as Metodo, { holder: id, body })).status).toBe(400);
    }
    expect((await crearTitular({ kind: "robot", name: "X" })).res.status).toBe(400);
    expect((await crearTitular({ kind: "persona" })).res.status).toBe(400);
  });

  it("el titular de otro tenant da 404 en todas las rutas y no cambia", async () => {
    const rutas: [Metodo, unknown][] = [
      [leer as Metodo, undefined],
      [editar as Metodo, { name: "Hackeado" }],
      [borrar as Metodo, undefined],
      [ponerPin as Metodo, { pin: "9999" }],
      [quitarPin as Metodo, undefined],
    ];
    for (const [metodo, body] of rutas) {
      // Como titular de la instalación B con la llave de A, y como titular de B en la instalación A.
      for (const inst of [instB, instA]) {
        const res = await pedir(metodo, { holder: holderB, inst, body });
        expect(res.status).toBe(404);
      }
    }
    expect((await pedir(listar as Metodo, { inst: instB })).status).toBe(404);
    expect((await pedir(crear as Metodo, { inst: instB, body: { kind: "persona", name: "Intruso" } })).status).toBe(404);
    const { data } = await admin.from("holders").select("name, deleted_at, pin_lookup").eq("id", holderB).single();
    expect(data).toEqual({ name: "Ajeno", deleted_at: null, pin_lookup: null });
    const { count } = await admin.from("holders").select("id", { count: "exact", head: true }).eq("installation_id", instB);
    expect(count).toBe(1);
  });

  it("PATCH con un solo campo conserva los demás y el PIN", async () => {
    const { json } = await crearTitular({ kind: "persona", name: "Luis", department: "5B", address: "Calle 1", notes: "n" });
    const id = json.data.id as string;
    await pedir(ponerPin as Metodo, { holder: id, body: { pin: "7777" } });
    const res = await pedir(editar as Metodo, { holder: id, body: { notes: "nueva" } });
    expect(res.status).toBe(200);
    const parchado = await res.json();
    expect(parchado.data).toMatchObject({ kind: "persona", name: "Luis", department: "5B", address: "Calle 1", notes: "nueva", has_pin: true });
    expect(parchado.revision).toBe(await revision());
    expect(await getHolderPinAs(actor(), tenantA, instA, id)).toBe("7777");
  });

  it("PATCH por la API sobre un titular creado desde la interfaz firma api:<keyId> en la fila y en audit_log", async () => {
    const { data: creado, error } = await admin
      .from("holders")
      .insert({ installation_id: instA, kind: "persona", name: "Desde UI", updated_by: `user:${randomUUID()}`, origin: "cloud" })
      .select("id")
      .single();
    if (error) throw error;
    const res = await pedir(editar as Metodo, { holder: creado.id, body: { name: "Desde API" } });
    expect(res.status).toBe(200);

    const { data: fila } = await admin.from("holders").select("name, updated_by").eq("id", creado.id).single();
    expect(fila).toEqual({ name: "Desde API", updated_by: `api:${keyId}` });
    const { data: auditoria } = await admin
      .from("audit_log")
      .select("updated_by, op")
      .eq("row_id", creado.id)
      .order("id", { ascending: false })
      .limit(1)
      .single();
    expect(auditoria).toEqual({ updated_by: `api:${keyId}`, op: "update" });
  });

  it("las rutas de PIN rechazan Idempotency-Key con 400 y no guardan nada en api_idempotency", async () => {
    const id = (await crearTitular({ kind: "persona", name: "Sin idem" })).json.data.id as string;
    const idem = `pin-${randomUUID()}`;
    for (const [metodo, body] of [
      [ponerPin as Metodo, { generate: true }],
      [ponerPin as Metodo, { pin: "2468" }],
      [quitarPin as Metodo, undefined],
    ] as const) {
      const res = await pedir(metodo, { holder: id, body, idem });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: "bad_request", message: "Esta ruta no admite Idempotency-Key." });
    }
    const { count } = await admin.from("api_idempotency").select("idem_key", { count: "exact", head: true }).eq("key_id", keyId);
    expect(count).toBe(0);
    expect((await pedir(leer as Metodo, { holder: id })).status).toBe(200);
    expect((await (await pedir(leer as Metodo, { holder: id })).json()).data.has_pin).toBe(false);
  });

  it("PUT pin con generate y sin Idempotency-Key sigue funcionando", async () => {
    const id = (await crearTitular({ kind: "persona", name: "Con generate" })).json.data.id as string;
    const res = await pedir(ponerPin as Metodo, { holder: id, body: { generate: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.pin).toMatch(/^\d{6}$/);
  });

  it("la lectura por id y el PIN no pisan datos del titular", async () => {
    const id = (await crearTitular({ kind: "persona", name: "Original" })).json.data.id as string;
    await admin.from("holders").update({ name: "Cambiado en paralelo", updated_by: "prueba" }).eq("id", id);
    await pedir(ponerPin as Metodo, { holder: id, body: { pin: "8642" } });
    const { data } = await admin.from("holders").select("name, updated_by").eq("id", id).single();
    expect(data).toEqual({ name: "Cambiado en paralelo", updated_by: `api:${keyId}` });
  });
});
