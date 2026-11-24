import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as loteTarjetas } from "@/app/api/v1/installations/[installationId]/cards/batch/route";
import { GET as listarTarjetas, POST as crearTarjeta } from "@/app/api/v1/installations/[installationId]/cards/route";
import { DELETE as borrarTarjeta } from "@/app/api/v1/installations/[installationId]/cards/[cardId]/route";
import { POST as loteControles } from "@/app/api/v1/installations/[installationId]/controls/batch/route";
import { GET as listarControles } from "@/app/api/v1/installations/[installationId]/controls/route";
import { POST as loteTitulares } from "@/app/api/v1/installations/[installationId]/holders/batch/route";
import { POST as crearTitular } from "@/app/api/v1/installations/[installationId]/holders/route";
import {
  DELETE as borrarTitular,
  PATCH as editarTitular,
} from "@/app/api/v1/installations/[installationId]/holders/[holderId]/route";
import { GET as getChanges } from "@/app/api/device/v1/changes/route";
import { notFound } from "next/navigation";
import { batchRoute } from "@/lib/api/batch";
import { operacionesTitulares } from "@/lib/api/holders";
import { openapi } from "@/lib/api/openapi";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Lotes de la API pública (`POST .../{holders,cards,controls}/batch`) contra el Supabase LOCAL.
// Cubre los criterios de aceptación 1–11 del diseño 2026-11-24-api-lotes-design.md, la búsqueda
// por códigos (§7), el pull de un lote (filas con la misma revisión) y el tiempo de 200 elementos.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");

// Las rutas tipan sus params; aquí se pasan como objeto de cadenas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Metodo = (req: Request, ctx: { params: Promise<any> }) => Promise<Response>;

interface Resultado {
  ref: string;
  ok: boolean;
  id?: string;
  data?: Record<string, unknown>;
  status?: number;
  code?: string;
  message?: string;
}

describe("API pública: lotes", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  const paneles: string[] = [];
  let tenantA: string;
  let instA: string;
  let instB: string;
  let secretA: string;
  let keyA: string;
  let holderA: string;
  let panel1: { id: string; code: string; token: string };
  let siguiente = 2_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
  const codigo = () => ++siguiente;

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

  const ruta = (inst: string, resto: string) => `http://localhost/api/v1/installations/${inst}/${resto}`;

  async function llamar(
    metodo: Metodo,
    url: string,
    opciones: { method?: string; body?: unknown; raw?: string; idem?: string; params?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${secretA}` };
    if (opciones.idem) headers["idempotency-key"] = opciones.idem;
    const body = opciones.raw ?? (opciones.body === undefined ? undefined : JSON.stringify(opciones.body));
    const res = await metodo(new Request(url, { method: opciones.method ?? "POST", headers, body }), {
      params: Promise.resolve(opciones.params ?? {}),
    });
    const texto = await res.text();
    return { res, json: texto ? JSON.parse(texto) : null };
  }

  const lote = (metodo: Metodo, recurso: string, items: unknown, inst = instA) =>
    llamar(metodo, ruta(inst, `${recurso}/batch`), { body: { items }, params: { installationId: inst } });

  const revision = async (inst = instA) =>
    (await admin.from("installations").select("revision").eq("id", inst).single()).data!.revision as number;

  const llave = () => `k-${randomUUID()}`;

  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };

  beforeAll(async () => {
    requireLocalSupabase();
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");
    const { data: t, error: et } = await admin.from("tenants").insert({ name: `Lote ${sufijo}` }).select("id").single();
    if (et) throw et;
    tenantA = t.id;
    tenants.push(tenantA);
    instA = await instalacion(tenantA, "Lote A");
    instB = await instalacion(tenantA, "Lote B");
    secretA = `acc_${randomBytes(32).toString("base64url")}`;
    const { data: k, error } = await admin
      .from("api_keys")
      .insert({
        tenant_id: tenantA,
        name: "Lote",
        prefix: secretA.slice(0, 12),
        key_hash: sha256(secretA),
        requests_per_minute: 5000,
      })
      .select("id")
      .single();
    if (error) throw error;
    keyA = k.id;
    holderA = await titular(instA, "Ana");
    panel1 = { code: `PNL-${base32(4)}-${base32(4)}`, token: randomBytes(32).toString("base64url"), id: "" };
    const { data: p, error: ep } = await admin
      .from("panels")
      .insert({
        panel_code: panel1.code,
        panel_secret_hash: sha256(randomBytes(32).toString("hex")),
        device_token_hash: sha256(panel1.token),
        installation_id: instA,
        status: "active",
      })
      .select("id")
      .single();
    if (ep) throw ep;
    panel1.id = p.id;
    paneles.push(p.id);
  });

  afterAll(async () => {
    for (const [nombre, valor] of [
      ["PIN_ENC_KEY", claves.enc],
      ["PIN_LOOKUP_KEY", claves.lookup],
    ] as const) {
      if (valor === undefined) delete process.env[nombre];
      else process.env[nombre] = valor;
    }
    await admin.from("control_button_panels").delete().in("panel_id", paneles);
    await admin.from("panels").delete().in("id", paneles);
    await admin.from("api_keys").delete().eq("id", keyA);
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
  });

  it("1. tres create válidos: 200, tres ok con ids nuevos y la revisión sube exactamente 1", async () => {
    const r0 = await revision();
    const items = ["Uno", "Dos", "Tres"].map((name, i) => ({
      ref: `r${i}`,
      op: "create",
      idempotency_key: llave(),
      data: { kind: "persona", name },
    }));
    const { res, json } = await lote(loteTitulares, "holders", items);
    expect(res.status).toBe(200);
    expect(json.revision).toBe(r0 + 1);
    expect(await revision()).toBe(r0 + 1);
    const resultados = json.results as Resultado[];
    expect(resultados.map((r) => r.ok)).toEqual([true, true, true]);
    expect(new Set(resultados.map((r) => r.id)).size).toBe(3);
    expect(resultados[0].data).toMatchObject({ id: resultados[0].id, name: "Uno", kind: "persona" });
    const { data: filas } = await admin
      .from("holders")
      .select("id, revision")
      .in("id", resultados.map((r) => r.id!));
    expect(filas).toHaveLength(3);
    expect(new Set(filas!.map((f) => f.revision))).toEqual(new Set([r0 + 1]));
  });

  it("2 y 3. una tarjeta duplicada falla como el POST individual; las otras se guardan; repetir no duplica", async () => {
    const existente = codigo();
    const individual = await llamar(crearTarjeta, ruta(instA, "cards"), {
      body: { card_code: existente, holder_id: holderA },
      params: { installationId: instA },
    });
    expect(individual.res.status).toBe(201);
    const duplicadoIndividual = await llamar(crearTarjeta, ruta(instA, "cards"), {
      body: { card_code: existente, holder_id: holderA },
      params: { installationId: instA },
    });
    expect(duplicadoIndividual.res.status).toBe(409);

    const r0 = await revision();
    const [c1, c2] = [codigo(), codigo()];
    const items = [
      { ref: "a", op: "create", idempotency_key: llave(), data: { card_code: c1, holder_id: holderA } },
      { ref: "b", op: "create", idempotency_key: llave(), data: { card_code: existente, holder_id: holderA } },
      { ref: "c", op: "create", idempotency_key: llave(), data: { card_code: c2, holder_id: holderA, description: "x" } },
    ];
    const primero = await lote(loteTarjetas, "cards", items);
    expect(primero.res.status).toBe(200);
    const res = primero.json.results as Resultado[];
    expect(res[0].ok).toBe(true);
    expect(res[2].ok).toBe(true);
    expect(res[1]).toEqual({
      ref: "b",
      ok: false,
      status: 409,
      code: duplicadoIndividual.json.code,
      message: duplicadoIndividual.json.message,
    });
    expect(primero.json.revision).toBe(r0 + 1);
    const { data: guardadas } = await admin
      .from("cards")
      .select("id")
      .eq("installation_id", instA)
      .in("card_code", [c1, c2])
      .is("deleted_at", null);
    expect(guardadas).toHaveLength(2);

    // 3. Mismas llaves: sin duplicados, mismos ids y la revisión no cambia.
    const segundo = await lote(loteTarjetas, "cards", items);
    expect(segundo.res.status).toBe(200);
    expect(segundo.json.results).toEqual(primero.json.results);
    expect(segundo.json.revision).toBe(r0 + 1);
    expect(await revision()).toBe(r0 + 1);
    const { data: despues } = await admin
      .from("cards")
      .select("id")
      .eq("installation_id", instA)
      .in("card_code", [c1, c2]);
    expect(despues).toHaveLength(2);
  });

  it("4. la llave usada en el endpoint individual no se reaplica en el lote, y al revés", async () => {
    const k1 = llave();
    const cuerpo = { card_code: codigo(), holder_id: holderA, description: "ida" };
    const individual = await llamar(crearTarjeta, ruta(instA, "cards"), {
      body: cuerpo,
      idem: k1,
      params: { installationId: instA },
    });
    expect(individual.res.status).toBe(201);
    const r0 = await revision();
    // Mismo contenido con otro orden de llaves: el mismo.
    const desordenado = { description: "ida", holder_id: holderA, card_code: cuerpo.card_code };
    const enLote = await lote(loteTarjetas, "cards", [{ ref: "x", op: "create", idempotency_key: k1, data: desordenado }]);
    expect(enLote.json.results).toEqual([{ ref: "x", ok: true, id: individual.json.data.id, data: individual.json.data }]);
    expect(enLote.json.revision).toBe(r0);

    // Al revés: primero el lote, después la llamada individual con la misma llave.
    const k2 = llave();
    const cuerpo2 = { card_code: codigo(), holder_id: holderA };
    const primeroLote = await lote(loteTarjetas, "cards", [{ ref: "y", op: "create", idempotency_key: k2, data: cuerpo2 }]);
    const idLote = (primeroLote.json.results as Resultado[])[0].id;
    const r1 = await revision();
    const repetida = await llamar(crearTarjeta, ruta(instA, "cards"), {
      raw: `{ "holder_id": "${holderA}",  "card_code": ${cuerpo2.card_code} }`,
      idem: k2,
      params: { installationId: instA },
    });
    expect(repetida.res.status).toBe(201);
    expect(repetida.res.headers.get("idempotent-replayed")).toBe("true");
    expect(repetida.json.data.id).toBe(idLote);
    expect(repetida.json.revision).toBe(r1);
    expect(await revision()).toBe(r1);

    // DELETE individual y luego el mismo delete en un lote con la misma llave.
    const k3 = llave();
    const borrado = await llamar(borrarTarjeta, ruta(instA, `cards/${idLote}`), {
      method: "DELETE",
      idem: k3,
      params: { installationId: instA, cardId: idLote! },
    });
    expect(borrado.res.status).toBe(200);
    const enLote3 = await lote(loteTarjetas, "cards", [{ ref: "z", op: "delete", id: idLote, idempotency_key: k3 }]);
    expect(enLote3.json.results).toEqual([{ ref: "z", ok: true, id: idLote, data: { id: idLote } }]);

    // Misma llave con otro contenido: el mismo error que el endpoint individual.
    const otro = await llamar(crearTarjeta, ruta(instA, "cards"), {
      body: { ...cuerpo, description: "otra" },
      idem: k1,
      params: { installationId: instA },
    });
    expect(otro.res.status).toBe(422);
    const otroLote = await lote(loteTarjetas, "cards", [
      { ref: "m", op: "create", idempotency_key: k1, data: { ...cuerpo, description: "otra" } },
    ]);
    expect(otroLote.json.results).toEqual([{ ref: "m", ok: false, status: 422, ...otro.json }]);
  });

  it("5. items vacío, 201 elementos, ref repetido o sin idempotency_key: 400 invalid_batch sin cambios", async () => {
    const r0 = await revision();
    const crear = (i: number) => ({ ref: `r${i}`, op: "create", idempotency_key: llave(), data: { kind: "persona", name: `N${i}` } });
    const casos: unknown[] = [
      [],
      Array.from({ length: 201 }, (_, i) => crear(i)),
      [crear(1), { ...crear(2), ref: "r1" }],
      [{ ref: "a", op: "create", data: { kind: "persona", name: "x" } }],
      [{ ...crear(1), op: "upsert" }],
      "no es arreglo",
    ];
    for (const items of casos) {
      const { res, json } = await lote(loteTitulares, "holders", items);
      expect(res.status).toBe(400);
      expect(json.code).toBe("invalid_batch");
      expect(typeof json.message).toBe("string");
    }
    const malJson = await llamar(loteTitulares, ruta(instA, "holders/batch"), {
      raw: "{no json",
      params: { installationId: instA },
    });
    expect(malJson.res.status).toBe(400);
    expect(malJson.json.code).toBe("invalid_batch");
    expect(await revision()).toBe(r0);
    const { count } = await admin
      .from("holders")
      .select("id", { count: "exact", head: true })
      .eq("installation_id", instA)
      .like("name", "N%");
    expect(count).toBe(0);
  });

  it("6, 7 y 8. id faltante o sobrante (400) e id inexistente (404) fallan solo en su elemento, en orden", async () => {
    const h = await titular(instA, "Para editar");
    const inexistente = randomUUID();
    const individual404 = await llamar(borrarTitular, ruta(instA, `holders/${inexistente}`), {
      method: "DELETE",
      params: { installationId: instA, holderId: inexistente },
    });
    expect(individual404.res.status).toBe(404);
    const r0 = await revision();
    const items = [
      { ref: "u-sin-id", op: "update", idempotency_key: llave(), data: { name: "x" } },
      { ref: "ok-1", op: "update", id: h, idempotency_key: llave(), data: { name: "Editado" } },
      { ref: "d-sin-id", op: "delete", idempotency_key: llave() },
      { ref: "c-con-id", op: "create", id: h, idempotency_key: llave(), data: { kind: "persona", name: "y" } },
      { ref: "d-404", op: "delete", id: inexistente, idempotency_key: llave() },
      { ref: "ok-2", op: "create", idempotency_key: llave(), data: { kind: "domicilio", name: "Casa 1" } },
    ];
    const { res, json } = await lote(loteTitulares, "holders", items);
    expect(res.status).toBe(200);
    const r = json.results as Resultado[];
    expect(r.map((x) => x.ref)).toEqual(items.map((i) => i.ref));
    expect(r.map((x) => (x.ok ? "ok" : x.status))).toEqual([400, "ok", 400, 400, 404, "ok"]);
    expect(r.slice(0, 4).filter((x) => !x.ok).every((x) => x.code === "bad_request")).toBe(true);
    expect(r[4]).toEqual({ ref: "d-404", ok: false, status: 404, ...individual404.json });
    expect(r[1].data).toMatchObject({ id: h, name: "Editado" });
    expect(json.revision).toBe(r0 + 1);
  });

  it("un lote sin cambios no sube la revisión", async () => {
    const r0 = await revision();
    const { json } = await lote(loteTitulares, "holders", [
      { ref: "a", op: "delete", id: randomUUID(), idempotency_key: llave() },
      { ref: "b", op: "update", id: holderA, idempotency_key: llave(), data: {} },
    ]);
    expect((json.results as Resultado[]).map((x) => x.status)).toEqual([404, 400]);
    expect(json.revision).toBe(r0);
    expect(await revision()).toBe(r0);
  });

  it("9. una mezcla de create/update/delete deja el mismo estado que las llamadas una por una", async () => {
    const preparar = async (inst: string) => ({ h1: await titular(inst, "Mezcla Uno"), h2: await titular(inst, "Mezcla Dos") });
    const a = await preparar(instA);
    const b = await preparar(instB);
    const pasos = (ids: { h1: string; h2: string }) => [
      { op: "create", data: { kind: "domicilio", name: "Mezcla Nuevo", address: "Calle 1" } },
      { op: "update", id: ids.h1, data: { name: "Mezcla Uno bis" } },
      { op: "update", id: ids.h1, data: { notes: "nota" } },
      { op: "delete", id: ids.h2 },
      { op: "delete", id: ids.h2 },
    ];
    // Individual en la instalación B.
    const individuales: number[] = [];
    for (const p of pasos(b)) {
      const params = { installationId: instB, holderId: p.id ?? "" };
      const r =
        p.op === "create"
          ? await llamar(crearTitular, ruta(instB, "holders"), { body: p.data, params })
          : p.op === "update"
            ? await llamar(editarTitular, ruta(instB, `holders/${p.id}`), { method: "PATCH", body: p.data, params })
            : await llamar(borrarTitular, ruta(instB, `holders/${p.id}`), { method: "DELETE", params });
      individuales.push(r.res.status);
    }
    // Lote en la instalación A.
    const { json } = await lote(
      loteTitulares,
      "holders",
      pasos(a).map((p, i) => ({ ref: String(i), idempotency_key: llave(), ...p })),
    );
    expect((json.results as Resultado[]).map((r, i) => (r.ok ? (i === 0 ? 201 : 200) : r.status))).toEqual(individuales);
    const estado = async (inst: string, ids: { h1: string; h2: string }) => {
      const { data } = await admin
        .from("holders")
        .select("id, kind, name, address, notes, deleted_at")
        .eq("installation_id", inst)
        .like("name", "Mezcla%");
      return (data ?? [])
        .map((f) => ({
          rol: f.id === ids.h1 ? "h1" : f.id === ids.h2 ? "h2" : "nuevo",
          kind: f.kind,
          name: f.name,
          address: f.address,
          notes: f.notes,
          borrado: f.deleted_at !== null,
        }))
        .sort((x, y) => x.rol.localeCompare(y.rol));
    };
    expect(await estado(instA, a)).toEqual(await estado(instB, b));
  });

  it("10. los paneles ven un solo cambio de revisión por lote y el pull no parte el grupo", async () => {
    const r0 = await revision();
    const items = Array.from({ length: 30 }, (_, i) => ({
      ref: `p${i}`,
      op: "create",
      idempotency_key: llave(),
      data: { kind: "persona", name: `Pull ${i}` },
    }));
    const { json } = await lote(loteTitulares, "holders", items);
    expect(json.revision).toBe(r0 + 1);
    const { data: filas } = await admin
      .from("holders")
      .select("revision")
      .in("id", (json.results as Resultado[]).map((r) => r.id!));
    expect(new Set(filas!.map((f) => f.revision))).toEqual(new Set([r0 + 1]));

    // Un pull con una página menor que el grupo trae el grupo completo y el cursor avanza.
    const pedir = async (since: number, limit: number) => {
      const res = await getChanges(
        new Request(`http://localhost/api/device/v1/changes?since=${since}&limit=${limit}`, {
          headers: { authorization: `Device ${panel1.code}.${panel1.token}` },
        }),
      );
      expect(res.status).toBe(200);
      return res.json();
    };
    const pagina = await pedir(r0, 5);
    const ids = new Set(pagina.changes.filter((c: { table: string }) => c.table === "holders").map((c: { id: string }) => c.id));
    for (const r of json.results as Resultado[]) expect(ids.has(r.id)).toBe(true);
    expect(pagina.revision).toBe(r0 + 1);
    // Con cambios anteriores en la página, corta antes del grupo.
    const previa = await pedir(r0 - 1, 5);
    expect(previa.has_more).toBe(true);
    expect(previa.changes.every((c: { revision: number }) => c.revision < r0 + 1)).toBe(true);
  });

  it("un error inesperado en un elemento da 500 internal_error y los demás siguen", async () => {
    let n = 0;
    const operaciones = {
      async create() {
        n++;
        if (n === 2) throw new Error("falla rara");
        return { status: 201, id: `id-${n}`, data: { id: `id-${n}` } };
      },
      async update(): Promise<never> {
        throw new Error("no");
      },
      async delete(): Promise<never> {
        throw new Error("no");
      },
    };
    const req = new Request(ruta(instA, "prueba/batch"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secretA}` },
      body: JSON.stringify({
        items: [1, 2, 3].map((i) => ({ ref: `e${i}`, op: "create", idempotency_key: llave(), data: {} })),
      }),
    });
    const res = await batchRoute(req, instA, { operaciones, metodoUpdate: "PATCH" });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.results.map((r: Resultado) => (r.ok ? "ok" : `${r.status} ${r.code}`))).toEqual([
      "ok",
      "500 internal_error",
      "ok",
    ]);
  });

  it("un corte de la función a mitad del lote no reejecuta lo confirmado al reintentar", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      ref: `corte${i}`,
      op: "create",
      idempotency_key: llave(),
      data: { kind: "persona", name: `Corte ${i}` },
    }));
    const pedir = () =>
      new Request(ruta(instA, "holders/batch"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secretA}` },
        body: JSON.stringify({ items }),
      });
    // Tras 3 elementos la "función" se corta: un error interno de Next que el lote no atrapa.
    let n = 0;
    const cortada = {
      ...operacionesTitulares,
      async create(...args: Parameters<typeof operacionesTitulares.create>) {
        if (++n > 3) notFound();
        return operacionesTitulares.create(...args);
      },
    };
    const r0 = await revision();
    await expect(batchRoute(pedir(), instA, { operaciones: cortada, metodoUpdate: "PATCH" })).rejects.toThrow();
    // El lote se cerró igual (finally): lo confirmado ya está publicado.
    expect(await revision()).toBe(r0 + 1);
    const { data: antes } = await admin.from("holders").select("id, name").eq("installation_id", instA).like("name", "Corte%");
    expect(antes).toHaveLength(3);
    // La reserva del 4.º quedó en curso; pasados 60 s se retoma.
    await admin
      .from("api_idempotency")
      .update({ created_at: new Date(Date.now() - 61_000).toISOString() })
      .eq("key_id", keyA)
      .eq("idem_key", items[3].idempotency_key);

    const { json } = await lote(loteTitulares, "holders", items);
    const res = json.results as Resultado[];
    expect(res.every((r) => r.ok)).toBe(true);
    const porNombre = new Map(antes!.map((h) => [h.name, h.id]));
    for (let i = 0; i < 3; i++) expect(res[i].id).toBe(porNombre.get(`Corte ${i}`));
    const { data: despues } = await admin.from("holders").select("id").eq("installation_id", instA).like("name", "Corte%");
    expect(despues).toHaveLength(5);
    // Lo repetido trae la revisión que se guardó (la pendiente del primer intento).
    const { data: guardada } = await admin
      .from("api_idempotency")
      .select("status, response")
      .eq("key_id", keyA)
      .eq("idem_key", items[0].idempotency_key)
      .single();
    expect(guardada).toMatchObject({ status: 201, response: { body: { revision: r0 + 1 } } });
  });

  it("un lote cuenta como una petición para el límite y otro lote abierto da 429", async () => {
    const contar = async () =>
      (await admin.from("api_requests").select("key_id", { count: "exact", head: true }).eq("key_id", keyA)).count ?? 0;
    const antes = await contar();
    await lote(loteTitulares, "holders", [
      { ref: "1", op: "create", idempotency_key: llave(), data: { kind: "persona", name: "L1" } },
      { ref: "2", op: "create", idempotency_key: llave(), data: { kind: "persona", name: "L2" } },
    ]);
    expect((await contar()) - antes).toBe(1);

    const token = randomUUID();
    const { data: abierto } = await admin.rpc("api_batch_begin", {
      p_installation_id: instA,
      p_token: token,
      p_ttl_seconds: 30,
    });
    expect(abierto).toBe(true);
    try {
      const { res, json } = await lote(loteTitulares, "holders", [
        { ref: "1", op: "create", idempotency_key: llave(), data: { kind: "persona", name: "L3" } },
      ]);
      expect(res.status).toBe(429);
      expect(json.code).toBe("batch_in_progress");
      expect(res.headers.get("retry-after")).toBe("5");
    } finally {
      await admin.rpc("api_batch_end", { p_installation_id: instA, p_token: token });
    }
  });

  it("404 del lote completo si la instalación es de otro tenant o no existe", async () => {
    const { res, json } = await lote(
      loteTitulares,
      "holders",
      [{ ref: "1", op: "create", idempotency_key: llave(), data: { kind: "persona", name: "x" } }],
      randomUUID(),
    );
    expect(res.status).toBe(404);
    expect(json.code).toBe("not_found");
  });

  it("§7. busca tarjetas por códigos y controles por códigos RF", async () => {
    const [c1, c2] = [codigo(), codigo()];
    await lote(loteTarjetas, "cards", [
      { ref: "1", op: "create", idempotency_key: llave(), data: { card_code: c1, holder_id: holderA } },
      { ref: "2", op: "create", idempotency_key: llave(), data: { card_code: c2, holder_id: holderA } },
    ]);
    const tarjetas = await llamar(listarTarjetas, `${ruta(instA, "cards")}?codes=${c1},${c2},1`, {
      method: "GET",
      params: { installationId: instA },
    });
    expect(tarjetas.res.status).toBe(200);
    expect(tarjetas.json.data.map((c: { card_code: number }) => c.card_code).sort()).toEqual([c1, c2].sort());
    const vacia = await llamar(listarTarjetas, `${ruta(instA, "cards")}?codes=1`, {
      method: "GET",
      params: { installationId: instA },
    });
    expect(vacia.json).toEqual({ data: [] });
    for (const malo of ["", "a,b", Array.from({ length: 201 }, (_, i) => i).join(",")]) {
      const r = await llamar(listarTarjetas, `${ruta(instA, "cards")}?codes=${malo}`, {
        method: "GET",
        params: { installationId: instA },
      });
      expect(r.res.status).toBe(400);
      expect(r.json.code).toBe("bad_request");
    }

    const rf = codigo();
    const creado = await lote(loteControles, "controls", [
      {
        ref: "1",
        op: "create",
        idempotency_key: llave(),
        data: { holder_id: holderA, buttons: [{ button: 0, rf_code: rf, outputs: { [panel1.id]: 0 } }] },
      },
    ]);
    expect((creado.json.results as Resultado[])[0].ok).toBe(true);
    const controles = await llamar(listarControles, `${ruta(instA, "controls")}?rf_codes=${rf},5`, {
      method: "GET",
      params: { installationId: instA },
    });
    expect(controles.json.data.map((c: { id: string }) => c.id)).toEqual([(creado.json.results as Resultado[])[0].id]);
  });

  it("11. el OpenAPI documenta los lotes, sus esquemas, el máximo y la búsqueda por códigos", () => {
    const doc = openapi as {
      paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
      components: { schemas: Record<string, unknown> };
    };
    for (const r of ["holders", "cards", "controls"]) {
      expect(doc.paths[`/installations/{installationId}/${r}/batch`]?.post).toBeDefined();
    }
    expect(JSON.stringify(doc.components.schemas)).toContain('"maxItems":200');
    expect(doc.components.schemas.BatchResponse).toBeDefined();
    expect(doc.paths["/installations/{installationId}/cards"].get.parameters?.map((p) => p.name)).toContain("codes");
    expect(doc.paths["/installations/{installationId}/controls"].get.parameters?.map((p) => p.name)).toContain("rf_codes");
  });

  it("tiempo: lotes de 200 titulares, tarjetas y controles", { timeout: 300_000 }, async () => {
    const tiempos: Record<string, number> = {};
    // Peticiones a la base por lote: con la latencia de producción estiman el tiempo en Vercel.
    const peticiones: Record<string, number> = {};
    const medir = async (nombre: string, metodo: Metodo, recurso: string, items: unknown[]) => {
      const fetchOriginal = globalThis.fetch;
      let n = 0;
      globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        n++;
        return fetchOriginal(...args);
      }) as typeof fetch;
      const t0 = performance.now();
      const { res, json } = await lote(metodo, recurso, items, instB).finally(() => {
        globalThis.fetch = fetchOriginal;
      });
      tiempos[nombre] = Math.round(performance.now() - t0);
      peticiones[nombre] = n;
      expect(res.status).toBe(200);
      expect((json.results as Resultado[]).every((r) => r.ok)).toBe(true);
      return json.results as Resultado[];
    };
    const r0 = await revision(instB);
    const titulares = await medir(
      "titulares",
      loteTitulares,
      "holders",
      Array.from({ length: 200 }, (_, i) => ({
        ref: `t${i}`,
        op: "create",
        idempotency_key: llave(),
        data: { kind: "domicilio", name: `Casa ${i}`, address: `Calle ${i}` },
      })),
    );
    expect(await revision(instB)).toBe(r0 + 1);
    await medir(
      "tarjetas",
      loteTarjetas,
      "cards",
      titulares.map((t, i) => ({
        ref: `c${i}`,
        op: "create",
        idempotency_key: llave(),
        data: { card_code: codigo(), holder_id: t.id },
      })),
    );
    const { data: p, error } = await admin
      .from("panels")
      .insert({
        panel_code: `PNL-${base32(4)}-${base32(4)}`,
        panel_secret_hash: sha256(randomBytes(32).toString("hex")),
        installation_id: instB,
        status: "claimed",
      })
      .select("id")
      .single();
    if (error) throw error;
    paneles.push(p.id);
    await medir(
      "controles",
      loteControles,
      "controls",
      titulares.map((t, i) => ({
        ref: `k${i}`,
        op: "create",
        idempotency_key: llave(),
        data: { holder_id: t.id, buttons: [{ button: 0, rf_code: codigo(), outputs: { [p.id]: 0 } }] },
      })),
    );
    console.info("Tiempo de lotes de 200 (ms):", tiempos, "peticiones a la base:", peticiones);
    expect(await revision(instB)).toBe(r0 + 3);
    for (const ms of Object.values(tiempos)) expect(ms).toBeLessThan(60_000);
  });
});
