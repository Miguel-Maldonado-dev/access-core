import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getChanges } from "@/app/api/device/v1/changes/route";
import { GET as getChecksums } from "@/app/api/device/v1/checksums/route";
import { GET as getSnapshot } from "@/app/api/device/v1/snapshot/route";
import { encryptPin, pinLookup } from "@/lib/crypto";
import { tableChecksum } from "@/lib/device/checksum";
import {
  TABLES,
  dataSchemas,
  type ChangeItem,
  type PullResponse,
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
  r.changes.filter((c) => c.table === tabla).map((c) => c.id).sort();

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
    kb0 = await insertar("control_buttons", { ...i1, control_id: k1, button: 0, rf_code: 5555, output_index: 1 });
    kb1 = await insertar("control_buttons", { ...i1, control_id: k1, button: 1, rf_code: 5556, output_index: null });
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
      for (const tabla of ["outputs", "profile_panel_rules"]) {
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

      const revisiones = r.changes.map((c) => c.revision);
      expect(revisiones).toEqual([...revisiones].sort((a, b) => a - b));
      expect(new Set(revisiones).size).toBe(revisiones.length);
      expect(Math.max(...revisiones)).toBeLessThanOrEqual(R);
      expect(new Set(r.changes.map((c) => `${c.table}:${c.id}`)).size).toBe(r.changes.length);

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
          const delPull = r.changes
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
