import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getChanges, POST as postChanges } from "@/app/api/device/v1/changes/route";
import { GET as getChecksums } from "@/app/api/device/v1/checksums/route";
import { GET as getSnapshot } from "@/app/api/device/v1/snapshot/route";
import { encryptPin, pinLookup } from "@/lib/crypto";
import { tableChecksum } from "@/lib/device/checksum";
import {
  TABLES,
  dataSchemas,
  type ChangeItem,
  type PullResponse,
  type PushItem,
  type PushResponse,
  type TableName,
} from "@/lib/device/contract";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Integración contra el Supabase LOCAL: bajada de datos de la nube a cada panel
// (GET /changes, /checksums y /snapshot). Los handlers se invocan con `Request` y los
// datos se escriben como servidor (llave secreta) con updated_at, updated_by y origin.
// Cada corrida crea sus propios tenants, instalaciones y paneles, y los borra al final.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const URL_BASE = "http://localhost/api/device/v1";

interface PanelPrueba {
  id: string;
  code: string;
  token: string;
}

interface Snapshot {
  revision: number;
  rows: { id: string; data: Record<string, unknown> }[];
}

interface Checksums {
  revision: number;
  confirm_deletions: boolean;
  tables: Record<string, string>;
}

type Upsert = Extract<ChangeItem, { op: "upsert" }>;

const MASCARAS_EN_CERO = {
  output_mask: 0,
  card_reader_mask: 0,
  pin_reader_mask: 0,
  allow_rf: false,
  weekday_mask: 0,
  start_minute: 0,
  end_minute: 0,
};

function peticion(ruta: string, panel?: PanelPrueba): Request {
  const headers: Record<string, string> = {};
  if (panel) headers.authorization = `Device ${panel.code}.${panel.token}`;
  return new Request(`${URL_BASE}/${ruta}`, { headers });
}

async function pull(panel: PanelPrueba, since: number, limit?: number): Promise<PullResponse> {
  const query = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`;
  const res = await getChanges(peticion(`changes?${query}`, panel));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  return res.json();
}

async function checksums(panel: PanelPrueba): Promise<Checksums> {
  const res = await getChecksums(peticion("checksums", panel));
  expect(res.status).toBe(200);
  return res.json();
}

async function snapshot(panel: PanelPrueba, tabla: TableName): Promise<Snapshot> {
  const res = await getSnapshot(peticion(`snapshot?table=${tabla}`, panel));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  return res.json();
}

const buscar = (r: PullResponse, tabla: TableName, id: string) =>
  r.changes.find((c) => c.table === tabla && c.id === id);

const dataDe = (r: PullResponse, tabla: TableName, id: string) => {
  const cambio = buscar(r, tabla, id);
  expect(cambio, `${tabla} ${id}`).toBeDefined();
  expect(cambio!.op).toBe("upsert");
  return (cambio as Upsert).data;
};

const idsDe = (r: PullResponse, tabla: TableName) =>
  [...new Set(r.changes.filter((c) => c.table === tabla).map((c) => c.id))].sort();

/** Operaciones de un registro en la página, en orden. */
const opsDe = (r: PullResponse, tabla: TableName, id: string) =>
  r.changes.filter((c) => c.table === tabla && c.id === id).map((c) => c.op);

/** Posición de la primera operación `op` de un registro en la página (-1 si no está). */
const posicionDe = (r: PullResponse, tabla: TableName, id: string, op: ChangeItem["op"]) =>
  r.changes.findIndex((c) => c.table === tabla && c.id === id && c.op === op);

/** El último cambio de cada (tabla, id): lo que queda en el panel tras aplicar la página. */
function colapsar(r: PullResponse): ChangeItem[] {
  const ultimo = new Map<string, ChangeItem>();
  for (const c of r.changes) {
    const llave = `${c.table}:${c.id}`;
    ultimo.delete(llave);
    ultimo.set(llave, c);
  }
  return [...ultimo.values()];
}

describe("bajada de datos al panel (GET /changes, /checksums y /snapshot)", () => {
  const corrida = base32(6).toLowerCase();
  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };

  let admin: SupabaseClient;
  const tenants: string[] = [];
  const paneles: string[] = [];

  let inst1: string;
  let inst2: string;
  let panelA: PanelPrueba;
  let panelB: PanelPrueba;
  let panelC: PanelPrueba; // de la instalación 2 (otro tenant)
  let panelS: PanelPrueba; // en staging

  // Registros de la instalación 1
  let h1: string;
  let h2: string;
  let c1: string;
  let c2: string;
  let k1: string;
  let kb0: string;
  let kb1: string;
  let p0: string; // "Residente": regla en A, sin regla en B
  let p1: string; // "Servicio": regla en A y en B
  let r0a: string;
  let r1a: string;
  let hp1: string;
  let hp2: string;
  const salidasA: string[] = [];
  const salidasB: string[] = [];
  // Todos los ids de la instalación 2
  const idsInst2 = new Set<string>();

  const autor = () => ({
    updated_at: new Date().toISOString(),
    updated_by: "prueba",
    origin: "cloud",
  });

  async function insertar(tabla: string, fila: Record<string, unknown>): Promise<string> {
    const { data, error } = await admin
      .from(tabla)
      .insert({ ...fila, ...autor() })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }

  async function actualizar(tabla: string, id: string, cambios: Record<string, unknown>) {
    const { error } = await admin
      .from(tabla)
      .update({ ...cambios, ...autor() })
      .eq("id", id);
    if (error) throw error;
  }

  const borrar = (tabla: string, id: string) =>
    actualizar(tabla, id, { deleted_at: new Date().toISOString() });

  async function revisionDe(tabla: string, id: string): Promise<number> {
    const { data, error } = await admin.from(tabla).select("revision").eq("id", id).single();
    if (error) throw error;
    return data.revision;
  }

  async function revisionInstalacion(installationId: string): Promise<number> {
    const { data, error } = await admin
      .from("installations")
      .select("revision")
      .eq("id", installationId)
      .single();
    if (error) throw error;
    return data.revision;
  }

  async function crearPanel(installationId: string, status = "active"): Promise<PanelPrueba> {
    const panel = {
      code: `PNL-${base32(4)}-${base32(4)}`,
      token: randomBytes(32).toString("base64url"),
    };
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: panel.code,
        panel_secret_hash: sha256(randomBytes(32).toString("hex")),
        device_token_hash: sha256(panel.token),
        installation_id: installationId,
        status,
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    paneles.push(data.id);
    return { ...panel, id: data.id };
  }

  async function crearSalidas(panelId: string, installationId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const i of [0, 1, 2, 3]) {
      ids.push(
        await insertar("outputs", {
          installation_id: installationId,
          panel_id: panelId,
          output_index: i,
          alias: `Salida ${i + 1}`,
          duration_ms: 3000 + i,
          reader_mask: 1 << i,
          enabled: i !== 3,
        }),
      );
    }
    return ids;
  }

  const regla = (
    installationId: string,
    profileId: string,
    panelId: string,
    valores: Record<string, unknown>,
  ) =>
    insertar("profile_panel_rules", {
      installation_id: installationId,
      profile_id: profileId,
      panel_id: panelId,
      ...valores,
    });

  async function panelEnBase(id: string) {
    const { data, error } = await admin
      .from("panels")
      .select("synced_revision, last_sync_at")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");

    const { data: ts, error: e1 } = await admin
      .from("tenants")
      .insert([{ name: `Pull T1 ${corrida}` }, { name: `Pull T2 ${corrida}` }])
      .select("id, name");
    if (e1) throw e1;
    const tenant1 = ts.find((t) => t.name.startsWith("Pull T1"))!.id;
    const tenant2 = ts.find((t) => t.name.startsWith("Pull T2"))!.id;
    tenants.push(tenant1, tenant2);

    const { data: is, error: e2 } = await admin
      .from("installations")
      .insert([
        { tenant_id: tenant1, name: `Fracc 1 ${corrida}` },
        { tenant_id: tenant2, name: `Fracc 2 ${corrida}` },
      ])
      .select("id, tenant_id");
    if (e2) throw e2;
    inst1 = is.find((i) => i.tenant_id === tenant1)!.id;
    inst2 = is.find((i) => i.tenant_id === tenant2)!.id;

    panelA = await crearPanel(inst1);
    panelB = await crearPanel(inst1);
    panelS = await crearPanel(inst1, "staging");
    panelC = await crearPanel(inst2);

    const i1 = { installation_id: inst1 };
    h1 = await insertar("holders", {
      ...i1,
      kind: "persona",
      name: "Ana Pérez",
      department: "Torre 1",
      pin_ciphertext: encryptPin("4321"),
      pin_lookup: pinLookup(inst1, "4321"),
    });
    h2 = await insertar("holders", { ...i1, kind: "domicilio", name: "Casa 12", address: "Calle 5" });
    c1 = await insertar("cards", { ...i1, card_code: 1001, holder_id: h1, description: "Tarjeta Ana" });
    c2 = await insertar("cards", { ...i1, card_code: 4294967295, holder_id: h2 });
    k1 = await insertar("controls", { ...i1, holder_id: h2, description: "Control casa" });
    kb0 = await insertar("control_buttons", { ...i1, control_id: k1, button: 0, rf_code: 5555 });
    kb1 = await insertar("control_buttons", { ...i1, control_id: k1, button: 1, rf_code: 5556 });
    // Cada panel con su salida del mismo botón; kb1 vinculado a los dos sin salida.
    for (const [boton, panel, salida] of [
      [kb0, panelA, 1],
      [kb0, panelB, 2],
      [kb1, panelA, null],
      [kb1, panelB, null],
    ] as const) {
      await insertar("control_button_panels", { ...i1, button_id: boton, panel_id: panel.id, output_index: salida });
    }
    p0 = await insertar("access_profiles", { ...i1, name: "Residente", local_permission_id: 0 });
    p1 = await insertar("access_profiles", { ...i1, name: "Servicio", local_permission_id: 1 });
    r0a = await regla(inst1, p0, panelA.id, {
      output_mask: 1,
      card_reader_mask: 15,
      pin_reader_mask: 2,
      allow_rf: true,
      weekday_mask: 127,
      start_minute: 0,
      end_minute: 1439,
    });
    r1a = await regla(inst1, p1, panelA.id, {
      output_mask: 2,
      card_reader_mask: 1,
      pin_reader_mask: 0,
      allow_rf: false,
      weekday_mask: 31,
      start_minute: 480,
      end_minute: 1080,
    });
    await regla(inst1, p1, panelB.id, {
      output_mask: 4,
      card_reader_mask: 3,
      pin_reader_mask: 1,
      allow_rf: true,
      weekday_mask: 96,
      start_minute: 0,
      end_minute: 600,
    });
    hp1 = await insertar("holder_profiles", { ...i1, holder_id: h1, profile_id: p0 });
    hp2 = await insertar("holder_profiles", { ...i1, holder_id: h2, profile_id: p1 });
    salidasA.push(...(await crearSalidas(panelA.id, inst1)));
    salidasB.push(...(await crearSalidas(panelB.id, inst1)));

    // Instalación 2: el mismo código de tarjeta y el mismo permission_id que en la 1.
    const i2 = { installation_id: inst2 };
    const x = await insertar("holders", { ...i2, kind: "persona", name: "Beto" });
    const q0 = await insertar("access_profiles", { ...i2, name: "Residente", local_permission_id: 0 });
    // La regla llega al panel como el permiso del perfil (id = q0), no con su propio id.
    await regla(inst2, q0, panelC.id, {
      output_mask: 15,
      card_reader_mask: 15,
      pin_reader_mask: 15,
      allow_rf: true,
      weekday_mask: 127,
      start_minute: 0,
      end_minute: 1439,
    });
    for (const id of [
      x,
      q0,
      await insertar("cards", { ...i2, card_code: 1001, holder_id: x }),
      await insertar("holder_profiles", { ...i2, holder_id: x, profile_id: q0 }),
      ...(await crearSalidas(panelC.id, inst2)),
    ]) {
      idsInst2.add(id);
    }
  });

  afterAll(async () => {
    for (const [k, v] of [
      ["PIN_ENC_KEY", claves.enc],
      ["PIN_LOOKUP_KEY", claves.lookup],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!admin) return;
    // Salidas y reglas referencian a los paneles; los paneles a las instalaciones; los
    // tenants borran en cascada instalaciones, datos replicados y auditoría.
    if (paneles.length) {
      for (const tabla of ["outputs", "profile_panel_rules", "control_button_panels"]) {
        const { error } = await admin.from(tabla).delete().in("panel_id", paneles);
        if (error) throw error;
      }
      const { error } = await admin.from("panels").delete().in("id", paneles);
      if (error) throw error;
    }
    if (tenants.length) {
      const { error } = await admin.from("tenants").delete().in("id", tenants);
      if (error) throw error;
    }
  });

  describe("pull inicial", () => {
    it("el panel A recibe toda la instalación con su proyección, ordenada por revisión", async () => {
      const r = await pull(panelA, 0);
      const R = await revisionInstalacion(inst1);
      expect(r).toMatchObject({ revision: R, has_more: false, confirm_deletions: false });

      // Un registro puede repetirse (un botón por su cambio y por el de su vínculo, con su
      // control antes): todas sus apariciones traen lo mismo.
      const revisiones = r.changes.map((c) => c.revision);
      expect(revisiones).toEqual([...revisiones].sort((a, b) => a - b));
      expect(Math.max(...revisiones)).toBeLessThanOrEqual(R);
      for (const ultimo of colapsar(r)) {
        for (const c of r.changes.filter((x) => x.table === ultimo.table && x.id === ultimo.id)) {
          expect({ ...c, revision: 0 }).toEqual({ ...ultimo, revision: 0 });
        }
      }

      for (const cambio of r.changes) {
        expect(cambio.op).toBe("upsert");
        const valido = dataSchemas[cambio.table].safeParse((cambio as Upsert).data);
        expect(valido.success, `${cambio.table} ${JSON.stringify(valido.error?.issues)}`).toBe(true);
      }

      expect(dataDe(r, "holders", h1)).toEqual({
        kind: "persona",
        name: "Ana Pérez",
        department: "Torre 1",
        address: "",
        notes: "",
        pin: "4321",
      });
      expect(dataDe(r, "holders", h2)).toEqual({
        kind: "domicilio",
        name: "Casa 12",
        department: "",
        address: "Calle 5",
        notes: "",
        pin: null,
      });
      expect(dataDe(r, "cards", c1)).toEqual({ card_code: 1001, holder_id: h1, description: "Tarjeta Ana" });
      expect(dataDe(r, "cards", c2)).toEqual({ card_code: 4294967295, holder_id: h2, description: "" });
      expect(dataDe(r, "controls", k1)).toEqual({ holder_id: h2, description: "Control casa" });
      expect(dataDe(r, "control_buttons", kb0)).toEqual({
        control_id: k1,
        button: 0,
        rf_code: 5555,
        output_id: 1,
      });
      expect(dataDe(r, "control_buttons", kb1)).toMatchObject({ output_id: null });
      expect(posicionDe(r, "controls", k1, "upsert")).toBeLessThan(posicionDe(r, "control_buttons", kb0, "upsert"));
      expect(dataDe(r, "permissions", p0)).toEqual({
        permission_id: 0,
        name: "Residente",
        output_mask: 1,
        card_reader_mask: 15,
        pin_reader_mask: 2,
        allow_rf: true,
        weekday_mask: 127,
        start_minute: 0,
        end_minute: 1439,
      });
      expect(dataDe(r, "permissions", p1)).toMatchObject({ permission_id: 1, weekday_mask: 31, start_minute: 480 });
      expect(idsDe(r, "permissions")).toEqual([p0, p1].sort());
      expect(dataDe(r, "holder_permissions", hp1)).toEqual({ holder_id: h1, permission_id: 0 });
      expect(dataDe(r, "holder_permissions", hp2)).toEqual({ holder_id: h2, permission_id: 1 });

      // Solo las salidas de A, con output_id = output_index.
      expect(idsDe(r, "outputs")).toEqual([...salidasA].sort());
      expect(dataDe(r, "outputs", salidasA[3])).toEqual({
        output_id: 3,
        alias: "Salida 4",
        duration_ms: 3003,
        reader_mask: 8,
        enabled: false,
      });

      // Ningún dato de la otra instalación.
      for (const cambio of r.changes) expect(idsInst2.has(cambio.id)).toBe(false);

      const fila = await panelEnBase(panelA.id);
      expect(fila.synced_revision).toBe(0);
      expect(fila.last_sync_at).not.toBeNull();
    });

    it("el panel B, sin regla para Residente, recibe ese permiso con todas las máscaras en 0", async () => {
      const r = await pull(panelB, 0);
      expect(dataDe(r, "permissions", p0)).toEqual({ permission_id: 0, name: "Residente", ...MASCARAS_EN_CERO });
      expect(dataDe(r, "permissions", p1)).toEqual({
        permission_id: 1,
        name: "Servicio",
        output_mask: 4,
        card_reader_mask: 3,
        pin_reader_mask: 1,
        allow_rf: true,
        weekday_mask: 96,
        start_minute: 0,
        end_minute: 600,
      });
      expect(idsDe(r, "outputs")).toEqual([...salidasB].sort());
      // El mismo botón llega a B con la salida de su vínculo con B.
      expect(dataDe(r, "control_buttons", kb0)).toEqual({ control_id: k1, button: 0, rf_code: 5555, output_id: 2 });
    });

    it("un panel de otra instalación recibe solo sus datos (Riesgo 4)", async () => {
      const r = await pull(panelC, 0);
      expect(r.revision).toBe(await revisionInstalacion(inst2));
      expect(r.changes.length).toBe(idsInst2.size);
      for (const cambio of r.changes) expect(idsInst2.has(cambio.id), cambio.table).toBe(true);
    });

    it("con since igual o mayor que la revisión actual devuelve changes: []", async () => {
      const R = await revisionInstalacion(inst1);
      expect(await pull(panelA, R)).toEqual({
        revision: R,
        has_more: false,
        confirm_deletions: false,
        changes: [],
      });
      expect((await panelEnBase(panelA.id)).synced_revision).toBe(R);
      expect(await pull(panelA, R + 10)).toMatchObject({ revision: R, changes: [] });
    });
  });

  describe("GET /checksums y GET /snapshot", () => {
    it("el checksum de cada tabla coincide con el calculado de su snapshot", async () => {
      for (const panel of [panelA, panelB, panelC]) {
        const cs = await checksums(panel);
        expect(Object.keys(cs.tables).sort()).toEqual([...TABLES].sort());
        expect(cs.confirm_deletions).toBe(false);
        for (const tabla of TABLES) {
          const snap = await snapshot(panel, tabla);
          expect(snap.revision).toBe(cs.revision);
          expect(tableChecksum(snap.rows), tabla).toBe(cs.tables[tabla]);
        }
      }
      expect((await checksums(panelA)).revision).toBe(await revisionInstalacion(inst1));
    });

    it("sin borrados, el snapshot de cada tabla es igual al pull desde 0", async () => {
      for (const panel of [panelA, panelB]) {
        const r = await pull(panel, 0);
        for (const tabla of TABLES) {
          const snap = await snapshot(panel, tabla);
          const delPull = colapsar(r)
            .filter((c) => c.table === tabla)
            .map((c) => ({ id: c.id, data: (c as Upsert).data }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          expect(snap.rows, tabla).toEqual(delPull);
        }
      }
    });

    it("permissions trae una fila por perfil vivo (máscaras en 0 sin regla) y outputs solo las del panel", async () => {
      const permisos = await snapshot(panelB, "permissions");
      expect(permisos.rows.map((f) => f.id).sort()).toEqual([p0, p1].sort());
      expect(permisos.rows.find((f) => f.id === p0)!.data).toEqual({
        permission_id: 0,
        name: "Residente",
        ...MASCARAS_EN_CERO,
      });
      const salidas = await snapshot(panelB, "outputs");
      expect(salidas.rows.map((f) => f.id).sort()).toEqual([...salidasB].sort());
      const titulares = await snapshot(panelA, "holders");
      expect(titulares.rows.find((f) => f.id === h1)!.data.pin).toBe("4321");
    });

    it("una tabla inválida o ausente responde 400", async () => {
      for (const query of ["snapshot?table=panels", "snapshot?table=", "snapshot"]) {
        const res = await getSnapshot(peticion(query, panelA));
        expect(res.status, query).toBe(400);
        expect(await res.json()).toEqual({ code: "invalid_query", message: expect.any(String) });
      }
    });
  });

  describe("cambios posteriores", () => {
    it("una tarjeta borrada llega como delete, sin data", async () => {
      const since = await revisionInstalacion(inst1);
      await borrar("cards", c2);
      const r = await pull(panelA, since);
      expect(r).toEqual({
        revision: since + 1,
        has_more: false,
        confirm_deletions: false,
        changes: [{ table: "cards", op: "delete", id: c2, revision: since + 1 }],
      });
      const snap = await snapshot(panelA, "cards");
      expect(snap.rows.map((f) => f.id)).toEqual([c1]);
    });

    it("una regla borrada llega como upsert de permissions con máscaras en 0; el otro panel no recibe nada", async () => {
      const since = await revisionInstalacion(inst1);
      await borrar("profile_panel_rules", r0a);
      const r = await pull(panelA, since);
      expect(r.changes).toEqual([
        {
          table: "permissions",
          op: "upsert",
          id: p0,
          revision: since + 1,
          data: { permission_id: 0, name: "Residente", ...MASCARAS_EN_CERO },
        },
      ]);
      expect(await pull(panelB, since)).toMatchObject({ revision: since + 1, has_more: false, changes: [] });
    });

    it("un cambio del perfil y de su regla en la misma página emite una sola entrada con la revisión más alta", async () => {
      const since = await revisionInstalacion(inst1);
      await actualizar("access_profiles", p1, { name: "Servicio ext" });
      await actualizar("profile_panel_rules", r1a, { card_reader_mask: 7 });

      const a = await pull(panelA, since);
      expect(a.changes).toEqual([
        {
          table: "permissions",
          op: "upsert",
          id: p1,
          revision: since + 2,
          data: {
            permission_id: 1,
            name: "Servicio ext",
            output_mask: 2,
            card_reader_mask: 7,
            pin_reader_mask: 0,
            allow_rf: false,
            weekday_mask: 31,
            start_minute: 480,
            end_minute: 1080,
          },
        },
      ]);

      // B solo ve el cambio del perfil (la regla de A no es suya).
      const b = await pull(panelB, since);
      expect(b.revision).toBe(since + 2);
      expect(b.changes).toEqual([
        expect.objectContaining({ table: "permissions", id: p1, revision: since + 1 }),
      ]);
      expect(dataDe(b, "permissions", p1)).toMatchObject({ name: "Servicio ext", card_reader_mask: 3 });
    });

    it("el borrado de un perfil llega como un solo delete de permissions, más el de sus holder_permissions", async () => {
      const since = await revisionInstalacion(inst1);
      await borrar("access_profiles", p1);

      const esperada = Math.max(await revisionDe("access_profiles", p1), await revisionDe("profile_panel_rules", r1a));
      const a = await pull(panelA, since);
      expect(a.changes.filter((c) => c.table === "permissions")).toEqual([
        { table: "permissions", op: "delete", id: p1, revision: esperada },
      ]);
      expect(a.changes.filter((c) => c.table === "holder_permissions")).toEqual([
        { table: "holder_permissions", op: "delete", id: hp2, revision: await revisionDe("holder_profiles", hp2) },
      ]);
      expect(a.changes).toHaveLength(2);

      const b = await pull(panelB, since);
      expect(b.changes.filter((c) => c.table === "permissions")).toEqual([
        expect.objectContaining({ op: "delete", id: p1 }),
      ]);
      expect(b.changes.find((c) => c.table === "permissions")).not.toHaveProperty("data");

      const permisos = await snapshot(panelA, "permissions");
      expect(permisos.rows.map((f) => f.id)).toEqual([p0]);
      expect((await snapshot(panelA, "holder_permissions")).rows.map((f) => f.id)).toEqual([hp1]);
    });
  });

  describe("controles por panel (vínculos botón–panel)", () => {
    let rfSiguiente = 7000;
    const nuevoRf = () => rfSiguiente++;

    const control = (descripcion: string) =>
      insertar("controls", { installation_id: inst1, holder_id: h2, description: descripcion });
    const boton = (controlId: string, numero: number, rf = nuevoRf()) =>
      insertar("control_buttons", { installation_id: inst1, control_id: controlId, button: numero, rf_code: rf });
    const vincular = (botonId: string, panel: PanelPrueba, salida: number | null) =>
      insertar("control_button_panels", {
        installation_id: inst1,
        button_id: botonId,
        panel_id: panel.id,
        output_index: salida,
      });

    async function push(panel: PanelPrueba, changes: PushItem[]): Promise<PushResponse> {
      const res = await postChanges(
        new Request(`${URL_BASE}/changes`, {
          method: "POST",
          headers: {
            authorization: `Device ${panel.code}.${panel.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ changes }),
        }),
      );
      expect(res.status).toBe(200);
      return res.json();
    }

    // Control con un botón vinculado solo a A (de la primera prueba; la cuarta lo vincula a B).
    let soloA: string;
    let botonSoloA: string;
    // Control con un botón vinculado a los dos paneles con salidas distintas.
    let compartido: string;
    let botonCompartido: string;
    let vinculoCompartidoB: string;

    it("el Panel 2 no recibe un botón vinculado solo al Panel 1, ni su control si todos sus botones son del Panel 1", async () => {
      const since = await revisionInstalacion(inst1);
      soloA = await control("Solo del Panel 1");
      botonSoloA = await boton(soloA, 0);
      await vincular(botonSoloA, panelA, 2);

      const a = await pull(panelA, since);
      expect(dataDe(a, "controls", soloA)).toEqual({ holder_id: h2, description: "Solo del Panel 1" });
      expect(dataDe(a, "control_buttons", botonSoloA)).toMatchObject({ control_id: soloA, output_id: 2 });
      expect(opsDe(a, "controls", soloA)).not.toContain("delete");
      expect(opsDe(a, "control_buttons", botonSoloA)).not.toContain("delete");
      expect(posicionDe(a, "controls", soloA, "upsert")).toBeLessThan(
        posicionDe(a, "control_buttons", botonSoloA, "upsert"),
      );

      // B solo puede recibir borrados de lo que nunca tuvo (el panel los ignora).
      const b = await pull(panelB, since);
      expect(opsDe(b, "controls", soloA)).not.toContain("upsert");
      expect(opsDe(b, "control_buttons", botonSoloA)).not.toContain("upsert");
      expect(colapsar(b).filter((c) => c.op === "upsert")).toEqual([]);
    });

    it("cada panel recibe su propia salida del mismo botón", async () => {
      const since = await revisionInstalacion(inst1);
      compartido = await control("Compartido");
      botonCompartido = await boton(compartido, 0);
      await vincular(botonCompartido, panelA, 0);
      vinculoCompartidoB = await vincular(botonCompartido, panelB, 3);

      for (const [panel, salida] of [
        [panelA, 0],
        [panelB, 3],
      ] as const) {
        const r = await pull(panel, since);
        expect(dataDe(r, "controls", compartido)).toEqual({ holder_id: h2, description: "Compartido" });
        expect(dataDe(r, "control_buttons", botonCompartido)).toEqual({
          control_id: compartido,
          button: 0,
          rf_code: expect.any(Number),
          output_id: salida,
        });
        const snap = await snapshot(panel, "control_buttons");
        expect(snap.rows.find((f) => f.id === botonCompartido)!.data.output_id).toBe(salida);
      }
    });

    it("desvincular el Panel 2 le envía delete del botón y del control", async () => {
      const since = await revisionInstalacion(inst1);
      await borrar("control_button_panels", vinculoCompartidoB);
      const revision = await revisionDe("control_button_panels", vinculoCompartidoB);

      expect((await pull(panelB, since)).changes).toEqual([
        { table: "control_buttons", op: "delete", id: botonCompartido, revision },
        { table: "controls", op: "delete", id: compartido, revision },
      ]);
      // El vínculo es de B: A no recibe nada.
      expect((await pull(panelA, since)).changes).toEqual([]);
    });

    it("vincular por primera vez al Panel 2 le envía upsert del control antes que el del botón", async () => {
      const since = await revisionInstalacion(inst1);
      const vinculo = await vincular(botonSoloA, panelB, 1);
      const revision = await revisionDe("control_button_panels", vinculo);

      expect((await pull(panelB, since)).changes).toEqual([
        {
          table: "controls",
          op: "upsert",
          id: soloA,
          revision,
          data: { holder_id: h2, description: "Solo del Panel 1" },
        },
        {
          table: "control_buttons",
          op: "upsert",
          id: botonSoloA,
          revision,
          data: { control_id: soloA, button: 0, rf_code: expect.any(Number), output_id: 1 },
        },
      ]);
    });

    it("un control sin botones llega a ambos paneles, también cuando pierde su último botón", async () => {
      let since = await revisionInstalacion(inst1);
      const vacio = await control("Sin botones");
      for (const panel of [panelA, panelB]) {
        expect(dataDe(await pull(panel, since), "controls", vacio)).toEqual({ holder_id: h2, description: "Sin botones" });
      }

      // Un control con su único botón en A: B no lo tiene; al borrarse el botón, le llega.
      const k = await control("Pierde su botón");
      const b = await boton(k, 0);
      await vincular(b, panelA, 0);
      since = await revisionInstalacion(inst1);
      await borrar("control_buttons", b);
      for (const panel of [panelA, panelB]) {
        const r = await pull(panel, since);
        expect(opsDe(r, "control_buttons", b)).toEqual(expect.arrayContaining(["delete"]));
        expect(opsDe(r, "control_buttons", b)).not.toContain("upsert");
        expect(posicionDe(r, "control_buttons", b, "delete")).toBeLessThan(posicionDe(r, "controls", k, "upsert"));
        expect(colapsar(r).find((c) => c.table === "controls" && c.id === k)).toMatchObject({
          op: "upsert",
          data: { description: "Pierde su botón" },
        });
      }
    });

    it("panelChecksums y panelSnapshot del Panel 2 excluyen los botones y controles del Panel 1", async () => {
      const k = await control("Otro solo del Panel 1");
      const b = await boton(k, 1);
      await vincular(b, panelA, 3);

      const controlesA = (await snapshot(panelA, "controls")).rows.map((f) => f.id);
      const botonesA = await snapshot(panelA, "control_buttons");
      expect(controlesA).toContain(k);
      expect(botonesA.rows.find((f) => f.id === b)!.data).toEqual({
        control_id: k,
        button: 1,
        rf_code: expect.any(Number),
        output_id: 3,
      });

      const controlesB = await snapshot(panelB, "controls");
      const botonesB = await snapshot(panelB, "control_buttons");
      expect(controlesB.rows.map((f) => f.id)).not.toContain(k);
      expect(controlesB.rows.map((f) => f.id)).not.toContain(compartido);
      expect(controlesB.rows.map((f) => f.id)).toEqual(expect.arrayContaining([k1, soloA]));
      expect(botonesB.rows.map((f) => f.id)).not.toContain(b);
      expect(botonesB.rows.map((f) => f.id)).not.toContain(botonCompartido);
      // Ningún botón de B apunta a un control que B no recibe.
      const idsControlesB = new Set(controlesB.rows.map((f) => f.id));
      for (const f of botonesB.rows) expect(idsControlesB.has(f.data.control_id as string)).toBe(true);

      for (const [panel, controles, botones] of [
        [panelB, controlesB, botonesB],
        [panelA, await snapshot(panelA, "controls"), botonesA],
      ] as const) {
        const cs = await checksums(panel);
        expect(cs.tables.controls).toBe(tableChecksum(controles.rows));
        expect(cs.tables.control_buttons).toBe(tableChecksum(botones.rows));
      }
    });

    it("una fusión en el Panel 2 le envía en su siguiente pull el control y luego el botón", async () => {
      const k = await control("Control del Panel 1");
      const codigo = nuevoRf();
      const existente = await boton(k, 0, codigo);
      await vincular(existente, panelA, 0);
      const since = await revisionInstalacion(inst1);

      // El técnico registra en el Panel 2 el mismo control: un control nuevo y su botón.
      const controlNuevo = randomUUID();
      const botonNuevo = randomUUID();
      const hora = new Date(Date.now() + 1000).toISOString();
      const alta = await push(panelB, [
        {
          change_id: randomBytes(16).toString("hex"),
          table: "controls",
          op: "upsert",
          id: controlNuevo,
          updated_at: hora,
          data: { holder_id: h2, description: "El mismo, en el Panel 2" },
        },
        {
          change_id: randomBytes(16).toString("hex"),
          table: "control_buttons",
          op: "upsert",
          id: botonNuevo,
          updated_at: hora,
          data: { control_id: controlNuevo, button: 0, rf_code: codigo, output_id: 2 },
        },
      ]);
      expect(alta.results.map((r) => r.status)).toEqual(["applied", "rejected"]);
      expect(alta.results[1]).toMatchObject({ reason: "fusionado" });

      const r = await pull(panelB, since);
      expect(dataDe(r, "controls", k)).toEqual({ holder_id: h2, description: "Control del Panel 1" });
      expect(dataDe(r, "control_buttons", existente)).toEqual({
        control_id: k,
        button: 0,
        rf_code: codigo,
        output_id: 2,
      });
      expect(posicionDe(r, "controls", k, "upsert")).toBeLessThan(posicionDe(r, "control_buttons", existente, "upsert"));
      // El control vacío que creó el panel se borró; el botón rechazado no existe.
      expect(colapsar(r).find((c) => c.table === "controls" && c.id === controlNuevo)).toMatchObject({ op: "delete" });
      expect(opsDe(r, "control_buttons", botonNuevo)).not.toContain("upsert");
      // A sigue con su salida.
      const botonesA = await snapshot(panelA, "control_buttons");
      expect(botonesA.rows.find((f) => f.id === existente)!.data.output_id).toBe(0);
    });

    it("una fusión que revive el vínculo borrado con el Panel 2 le envía el control y luego el botón", async () => {
      const k = await control("Control revivido");
      const codigo = nuevoRf();
      const existente = await boton(k, 0, codigo);
      await vincular(existente, panelA, 0);
      const vinculoB = await vincular(existente, panelB, 1);
      // La nube desvincula el Panel 2: deja de recibir el botón y el control.
      let since = await revisionInstalacion(inst1);
      await borrar("control_button_panels", vinculoB);
      expect(colapsar(await pull(panelB, since)).map((c) => [c.table, c.op, c.id])).toEqual([
        ["control_buttons", "delete", existente],
        ["controls", "delete", k],
      ]);

      // El técnico vuelve a registrar el control en el Panel 2: la fusión revive el vínculo.
      since = await revisionInstalacion(inst1);
      const controlNuevo = randomUUID();
      const hora = new Date(Date.now() + 1000).toISOString();
      const alta = await push(panelB, [
        {
          change_id: randomBytes(16).toString("hex"),
          table: "controls",
          op: "upsert",
          id: controlNuevo,
          updated_at: hora,
          data: { holder_id: h2, description: "Otra vez en el Panel 2" },
        },
        {
          change_id: randomBytes(16).toString("hex"),
          table: "control_buttons",
          op: "upsert",
          id: randomUUID(),
          updated_at: hora,
          data: { control_id: controlNuevo, button: 0, rf_code: codigo, output_id: 3 },
        },
      ]);
      expect(alta.results[1]).toMatchObject({ status: "rejected", reason: "fusionado" });
      // Se revivió la misma fila del vínculo, no se creó otra.
      const { data: vinculos, error } = await admin
        .from("control_button_panels")
        .select("id, output_index, deleted_at")
        .eq("button_id", existente)
        .eq("panel_id", panelB.id);
      if (error) throw error;
      expect(vinculos).toEqual([{ id: vinculoB, output_index: 3, deleted_at: null }]);

      const r = await pull(panelB, since);
      expect(dataDe(r, "controls", k)).toEqual({ holder_id: h2, description: "Control revivido" });
      expect(dataDe(r, "control_buttons", existente)).toEqual({
        control_id: k,
        button: 0,
        rf_code: codigo,
        output_id: 3,
      });
      expect(posicionDe(r, "controls", k, "upsert")).toBeLessThan(posicionDe(r, "control_buttons", existente, "upsert"));
    });
  });

  describe("paginación", () => {
    it("con más cambios que limit, las páginas juntas dan todo, en orden, sin repetir ni saltar", async () => {
      const since = await revisionInstalacion(inst1);
      const h3 = await insertar("holders", { installation_id: inst1, kind: "persona", name: "Carla" });
      for (const codigo of [2001, 2002, 2003]) {
        await insertar("cards", { installation_id: inst1, card_code: codigo, holder_id: h3 });
      }
      // Un cambio de otro panel en medio: A no lo recibe y no rompe la paginación.
      await actualizar("outputs", salidasB[0], { alias: "Pluma vehicular" });
      for (const codigo of [2004, 2005, 2006]) {
        await insertar("cards", { installation_id: inst1, card_code: codigo, holder_id: h3 });
      }
      const R = await revisionInstalacion(inst1);

      const completo = await pull(panelA, since);
      expect(completo.revision).toBe(R);
      expect(completo.changes).toHaveLength(7);
      expect(completo.changes.some((c) => c.table === "outputs")).toBe(false);

      const paginas: PullResponse[] = [];
      let cursor = since;
      for (let i = 0; i < 10; i++) {
        const pagina = await pull(panelA, cursor, 3);
        paginas.push(pagina);
        expect((await panelEnBase(panelA.id)).synced_revision).toBe(cursor);
        cursor = pagina.revision;
        if (!pagina.has_more) break;
      }
      expect(paginas.map((p) => p.changes.length)).toEqual([3, 3, 1]);
      expect(paginas.map((p) => p.has_more)).toEqual([true, true, false]);
      for (const pagina of paginas.slice(0, -1)) {
        expect(pagina.revision).toBe(pagina.changes.at(-1)!.revision);
      }
      expect(cursor).toBe(R);
      expect(paginas.flatMap((p) => p.changes)).toEqual(completo.changes);
    });

    it("con más filas que max_rows de PostgREST, el snapshot y el pull de 500 en 500 no pierden ninguna", async () => {
      const since = await revisionInstalacion(inst1);
      const h4 = await insertar("holders", { installation_id: inst1, kind: "domicilio", name: "Bodega" });
      const { error } = await admin.from("cards").insert(
        Array.from({ length: 1001 }, (_, i) => ({
          installation_id: inst1,
          card_code: 100000 + i,
          holder_id: h4,
          ...autor(),
        })),
      );
      if (error) throw error;

      const { count, error: errorCuenta } = await admin
        .from("cards")
        .select("id", { count: "exact", head: true })
        .eq("installation_id", inst1)
        .is("deleted_at", null);
      if (errorCuenta) throw errorCuenta;
      const snap = await snapshot(panelA, "cards");
      expect(snap.rows).toHaveLength(count!);
      expect(count).toBeGreaterThan(1001);
      expect(tableChecksum(snap.rows)).toBe((await checksums(panelA)).tables.cards);

      const tamanos: number[] = [];
      const vistos = new Set<string>();
      let cursor = since;
      for (let i = 0; i < 10; i++) {
        const pagina = await pull(panelA, cursor);
        tamanos.push(pagina.changes.length);
        for (const c of pagina.changes) vistos.add(c.id);
        cursor = pagina.revision;
        if (!pagina.has_more) break;
      }
      expect(tamanos).toEqual([500, 500, 2]);
      expect(vistos.size).toBe(1002);
      expect(cursor).toBe(await revisionInstalacion(inst1));
    });

    it("since y limit inválidos responden 400", async () => {
      for (const query of [
        "",
        "since=",
        "since=-1",
        "since=abc",
        "since=1.5",
        "since=0&limit=0",
        "since=0&limit=501",
        "since=0&limit=x",
      ]) {
        const res = await getChanges(peticion(`changes?${query}`, panelA));
        expect(res.status, query).toBe(400);
        expect(await res.json()).toEqual({ code: "invalid_query", message: expect.any(String) });
      }
      expect((await getChanges(peticion("changes?since=0&limit=500", panelA))).status).toBe(200);
    });
  });

  describe("acceso", () => {
    it("un panel que no está activo recibe 409 not_active en las tres rutas", async () => {
      for (const [handler, ruta] of [
        [getChanges, "changes?since=0"],
        [getChecksums, "checksums"],
        [getSnapshot, "snapshot?table=cards"],
      ] as const) {
        const res = await handler(peticion(ruta, panelS));
        expect(res.status, ruta).toBe(409);
        expect(await res.json()).toEqual({ code: "not_active", message: expect.any(String) });
      }
    });

    it("sin credencial responde 401", async () => {
      for (const [handler, ruta] of [
        [getChanges, "changes?since=0"],
        [getChecksums, "checksums"],
        [getSnapshot, "snapshot?table=cards"],
      ] as const) {
        const res = await handler(peticion(ruta));
        expect(res.status, ruta).toBe(401);
        expect(await res.json()).toMatchObject({ code: "unauthorized" });
      }
    });

    it("confirm_deletions es verdadero solo mientras confirm_deletions_until está en el futuro", async () => {
      const R = await revisionInstalacion(inst1);
      const fijar = async (ms: number) => {
        const { error } = await admin
          .from("panels")
          .update({ confirm_deletions_until: new Date(Date.now() + ms).toISOString() })
          .eq("id", panelA.id);
        if (error) throw error;
      };
      await fijar(60 * 60 * 1000);
      expect((await pull(panelA, R)).confirm_deletions).toBe(true);
      expect((await checksums(panelA)).confirm_deletions).toBe(true);
      await fijar(-60 * 1000);
      expect((await pull(panelA, R)).confirm_deletions).toBe(false);
      expect((await checksums(panelA)).confirm_deletions).toBe(false);
    });
  });
});
