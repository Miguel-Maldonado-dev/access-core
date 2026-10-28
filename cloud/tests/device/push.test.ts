import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getChanges, POST as postChanges } from "@/app/api/device/v1/changes/route";
import { decryptPin, encryptPin, pinLookup } from "@/lib/crypto";
import { MAX_CLOCK_SKEW_S, retryOnDeadlock } from "@/lib/device/apply";
import {
  CHANGES_PAGE,
  type PullResponse,
  type PushItem,
  type PushResponse,
  type PushResult,
  type TableData,
  type TableName,
} from "@/lib/device/contract";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Integración contra el Supabase LOCAL: subida de cambios del panel (POST /changes).
// Los handlers se invocan con `Request`; las filas de partida se escriben como servidor
// (llave secreta) con updated_at, updated_by y origin, como pide el trigger de N3.
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

type Fila = Record<string, unknown>;

/** Fecha ISO desplazada `ms` milisegundos desde ahora (por omisión, 1 s después). */
const hora = (ms = 1000) => new Date(Date.now() + ms).toISOString();
const nuevoCambio = () => randomBytes(16).toString("hex");

function upsert<T extends TableName>(table: T, id: string, data: TableData[T], updated_at = hora()): PushItem {
  return { change_id: nuevoCambio(), table, op: "upsert", id, updated_at, data } as PushItem;
}

function borrado(table: TableName, id: string, updated_at = hora()): PushItem {
  return { change_id: nuevoCambio(), table, op: "delete", id, updated_at };
}

function peticion(ruta: string, panel?: PanelPrueba, cuerpo?: unknown): Request {
  const headers: Record<string, string> = {};
  if (panel) headers.authorization = `Device ${panel.code}.${panel.token}`;
  if (cuerpo === undefined) return new Request(`${URL_BASE}/${ruta}`, { headers });
  headers["content-type"] = "application/json";
  return new Request(`${URL_BASE}/${ruta}`, {
    method: "POST",
    headers,
    body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
  });
}

async function push(panel: PanelPrueba, changes: PushItem[]): Promise<PushResponse> {
  const res = await postChanges(peticion("changes", panel, { changes }));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  return res.json();
}

async function pushUno(panel: PanelPrueba, item: PushItem): Promise<PushResult> {
  const r = await push(panel, [item]);
  expect(r.results).toHaveLength(1);
  expect(r.results[0].change_id).toBe(item.change_id);
  return r.results[0];
}

async function pull(panel: PanelPrueba, since: number): Promise<PullResponse> {
  const res = await getChanges(peticion(`changes?since=${since}`, panel));
  expect(res.status).toBe(200);
  return res.json();
}

describe("subida de cambios del panel (POST /changes)", () => {
  const corrida = base32(6).toLowerCase();
  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };

  let admin: SupabaseClient;
  const tenants: string[] = [];
  const paneles: string[] = [];

  let tenant1: string;
  let inst1: string;
  let inst2: string;
  let panelA: PanelPrueba;
  let panelB: PanelPrueba;
  let panelC: PanelPrueba; // de la instalación 2 (otro tenant)
  let panelS: PanelPrueba; // en staging

  // Instalación 1
  const PIN_ANA = "731864";
  let hA: string; // Ana, con PIN
  let hB: string; // Beto, sin PIN
  let kA: string; // tarjeta 1001 de Ana
  let kc: string; // control de Beto
  let kb: string; // botón 0 del control, rf 5555
  let p0: string; // Residente (permission_id 0), regla en A y en B
  let pX: string; // Temporal (permission_id 5), regla en A y en B, asignado a Ana y Beto
  let hp0: string; // Ana → Residente
  const salidasA: string[] = [];
  const salidasB: string[] = [];
  // Instalación 2
  let x: string; // titular de la instalación 2 (que también tiene un perfil con permission_id 0)

  const autor = () => ({ updated_at: new Date().toISOString(), updated_by: "prueba", origin: "cloud" });

  async function insertar(tabla: string, fila: Fila): Promise<string> {
    const { data, error } = await admin
      .from(tabla)
      .insert({ ...fila, ...autor() })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }

  async function actualizar(tabla: string, id: string, cambios: Fila) {
    const { error } = await admin
      .from(tabla)
      .update({ ...cambios, ...autor() })
      .eq("id", id);
    if (error) throw error;
  }

  const borrarEnLaNube = (tabla: string, id: string) =>
    actualizar(tabla, id, { deleted_at: new Date().toISOString() });

  async function fila(tabla: string, id: string): Promise<Fila | null> {
    const { data, error } = await admin.from(tabla).select("*").eq("id", id).maybeSingle<Fila>();
    if (error) throw error;
    return data;
  }

  async function filas(tabla: string, columna: string, valor: string): Promise<Fila[]> {
    const { data, error } = await admin.from(tabla).select("*").eq(columna, valor).order("id");
    if (error) throw error;
    return data as Fila[];
  }

  async function revisionInstalacion(installationId: string): Promise<number> {
    const { data, error } = await admin
      .from("installations")
      .select("revision")
      .eq("id", installationId)
      .single<{ revision: number }>();
    if (error) throw error;
    return data.revision;
  }

  async function conflictos(rowId: string): Promise<Fila[]> {
    const { data, error } = await admin.from("sync_conflicts").select("*").eq("row_id", rowId).order("id");
    if (error) throw error;
    return data as Fila[];
  }

  async function cambioGuardado(panelId: string, changeId: string): Promise<Fila[]> {
    const { data, error } = await admin
      .from("device_changes")
      .select("*")
      .eq("panel_id", panelId)
      .eq("change_id", changeId);
    if (error) throw error;
    return data as Fila[];
  }

  async function crearPanel(installationId: string, status = "active"): Promise<PanelPrueba> {
    const panel = { code: `PNL-${base32(4)}-${base32(4)}`, token: randomBytes(32).toString("base64url") };
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
          duration_ms: 3000,
          reader_mask: 1 << i,
          enabled: true,
        }),
      );
    }
    return ids;
  }

  const REGLA = {
    output_mask: 1,
    card_reader_mask: 15,
    pin_reader_mask: 2,
    allow_rf: true,
    weekday_mask: 127,
    start_minute: 0,
    end_minute: 1439,
  };

  const regla = (installationId: string, profileId: string, panelId: string, valores: Fila = REGLA) =>
    insertar("profile_panel_rules", {
      installation_id: installationId,
      profile_id: profileId,
      panel_id: panelId,
      ...valores,
    });

  const origenDe = (panel: PanelPrueba) => `panel:${panel.code}`;

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");

    const { data: ts, error: e1 } = await admin
      .from("tenants")
      .insert([{ name: `Push T1 ${corrida}` }, { name: `Push T2 ${corrida}` }])
      .select("id, name");
    if (e1) throw e1;
    tenant1 = ts.find((t) => t.name.startsWith("Push T1"))!.id;
    const tenant2 = ts.find((t) => t.name.startsWith("Push T2"))!.id;
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
    hA = await insertar("holders", {
      ...i1,
      kind: "persona",
      name: "Ana Pérez",
      pin_ciphertext: encryptPin(PIN_ANA),
      pin_lookup: pinLookup(inst1, PIN_ANA),
    });
    hB = await insertar("holders", { ...i1, kind: "persona", name: "Beto" });
    kA = await insertar("cards", { ...i1, card_code: 1001, holder_id: hA, description: "Tarjeta Ana" });
    kc = await insertar("controls", { ...i1, holder_id: hB, description: "Control Beto" });
    kb = await insertar("control_buttons", { ...i1, control_id: kc, button: 0, rf_code: 5555, output_index: 0 });
    p0 = await insertar("access_profiles", { ...i1, name: "Residente", local_permission_id: 0 });
    pX = await insertar("access_profiles", { ...i1, name: "Temporal", local_permission_id: 5 });
    for (const perfil of [p0, pX]) {
      await regla(inst1, perfil, panelA.id);
      await regla(inst1, perfil, panelB.id, { ...REGLA, output_mask: 2 });
    }
    hp0 = await insertar("holder_profiles", { ...i1, holder_id: hA, profile_id: p0 });
    await insertar("holder_profiles", { ...i1, holder_id: hA, profile_id: pX });
    await insertar("holder_profiles", { ...i1, holder_id: hB, profile_id: pX });
    salidasA.push(...(await crearSalidas(panelA.id, inst1)));
    salidasB.push(...(await crearSalidas(panelB.id, inst1)));

    const i2 = { installation_id: inst2 };
    x = await insertar("holders", { ...i2, kind: "persona", name: "Xavier" });
    await insertar("access_profiles", { ...i2, name: "Residente", local_permission_id: 0 });
    await crearSalidas(panelC.id, inst2);
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
    // Salidas y reglas referencian a los paneles; los paneles a las instalaciones (y
    // borran en cascada sus device_changes y sync_conflicts); los tenants borran en
    // cascada instalaciones, datos replicados y auditoría.
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

  describe("aplicación", () => {
    it("un alta de tarjeta queda applied, sube la revisión y llega a los otros paneles", async () => {
      const R0 = await revisionInstalacion(inst1);
      const id = randomUUID();
      const cuando = hora(-1000);
      const item = upsert("cards", id, { card_code: 7001, holder_id: hA, description: "Nueva" }, cuando);

      const r = await push(panelA, [item]);
      expect(r).toEqual({
        revision: R0 + 1,
        results: [{ change_id: item.change_id, status: "applied", revision: R0 + 1 }],
      });
      expect(await revisionInstalacion(inst1)).toBe(R0 + 1);

      const tarjeta = await fila("cards", id);
      expect(tarjeta).toMatchObject({
        installation_id: inst1,
        tenant_id: tenant1,
        card_code: 7001,
        holder_id: hA,
        description: "Nueva",
        updated_by: origenDe(panelA),
        origin: origenDe(panelA),
        deleted_at: null,
        revision: R0 + 1,
      });
      expect(Date.parse(tarjeta!.updated_at as string)).toBe(Date.parse(cuando));

      const b = await pull(panelB, R0);
      expect(b.changes).toEqual([
        {
          table: "cards",
          op: "upsert",
          id,
          revision: R0 + 1,
          data: { card_code: 7001, holder_id: hA, description: "Nueva" },
        },
      ]);
    });

    it("repetir el mismo change_id devuelve el resultado guardado sin aplicar dos veces (Riesgo 3)", async () => {
      const id = randomUUID();
      const item = upsert("cards", id, { card_code: 7002, holder_id: hA, description: "Una vez" });
      const primero = await pushUno(panelA, item);
      expect(primero.status).toBe("applied");
      const R = await revisionInstalacion(inst1);
      expect(primero.revision).toBe(R);

      // El mismo change_id con otro contenido: cuenta el resultado guardado, no el contenido.
      const repetido = { ...item, data: { card_code: 7002, holder_id: hA, description: "Dos veces" } } as PushItem;
      const r = await push(panelA, [item, repetido]);
      expect(r).toEqual({ revision: R, results: [primero, primero] });
      expect(await revisionInstalacion(inst1)).toBe(R);
      expect(await fila("cards", id)).toMatchObject({ description: "Una vez", revision: R });

      const guardados = await cambioGuardado(panelA.id, item.change_id);
      expect(guardados).toHaveLength(1);
      expect(guardados[0].result).toEqual({ status: "applied", revision: R });
    });

    it("un rechazo no deshace los demás cambios del lote y los resultados van en el orden recibido", async () => {
      const [k1, k2, k3] = [randomUUID(), randomUUID(), randomUUID()];
      const r = await push(panelA, [
        upsert("cards", k1, { card_code: 7101, holder_id: hB, description: "" }),
        upsert("cards", k2, { card_code: 1001, holder_id: hB, description: "" }),
        upsert("cards", k3, { card_code: 7103, holder_id: hB, description: "" }),
      ]);
      expect(r.results.map((x) => x.status)).toEqual(["applied", "rejected", "applied"]);
      expect(r.revision).toBe(await revisionInstalacion(inst1));
      expect(r.results[2].revision).toBe(r.revision);
      expect(await fila("cards", k1)).toMatchObject({ card_code: 7101, deleted_at: null });
      expect(await fila("cards", k2)).toBeNull();
      expect(await fila("cards", k3)).toMatchObject({ card_code: 7103, deleted_at: null });
    });

    it("un botón nuevo traduce output_id a output_index", async () => {
      const id = randomUUID();
      const datos = { control_id: kc, button: 2, rf_code: 5600, output_id: 2 };
      const r = await pushUno(panelA, upsert("control_buttons", id, datos));
      expect(r.status).toBe("applied");
      expect(await fila("control_buttons", id)).toMatchObject({ control_id: kc, button: 2, rf_code: 5600, output_index: 2 });
    });

    it("la edición de un titular con PIN guarda el PIN cifrado y su pin_lookup", async () => {
      const r = await pushUno(
        panelA,
        upsert("holders", hB, {
          kind: "persona",
          name: "Beto Ruiz",
          department: "Torre 2",
          address: "",
          notes: "",
          pin: "246810",
        }),
      );
      expect(r).toMatchObject({ status: "applied" });
      const titular = await fila("holders", hB);
      expect(titular).toMatchObject({
        name: "Beto Ruiz",
        department: "Torre 2",
        has_pin: true,
        origin: origenDe(panelA),
      });
      expect(decryptPin(titular!.pin_ciphertext as string)).toBe("246810");
      expect(titular!.pin_lookup).toBe(pinLookup(inst1, "246810"));
    });

    it("un updated_at 1 hora adelantado se guarda con la hora del servidor y deja conflicto skew (Riesgo 2)", async () => {
      expect(MAX_CLOCK_SKEW_S).toBe(300);
      const id = randomUUID();
      const futuro = hora(60 * 60 * 1000);
      const control0 = { holder_id: hA, description: "Reloj adelantado" };
      const r = await pushUno(panelA, upsert("controls", id, control0, futuro));
      expect(r.status).toBe("applied");

      const control = await fila("controls", id);
      expect(Math.abs(Date.parse(control!.updated_at as string) - Date.now())).toBeLessThan(60_000);
      const [skew, ...otros] = await conflictos(id);
      expect(otros).toEqual([]);
      expect(skew).toMatchObject({
        tenant_id: tenant1,
        installation_id: inst1,
        panel_id: panelA.id,
        table_name: "controls",
        kind: "skew",
      });
      expect((skew.panel_version as Fila).updated_at).toBe(futuro);

      // El reloj adelantado no gana siempre: un cambio posterior con la hora real gana.
      const control1 = { holder_id: hA, description: "Hora real" };
      const despues = await pushUno(panelA, upsert("controls", id, control1, hora(10_000)));
      expect(despues.status).toBe("applied");
      expect(await fila("controls", id)).toMatchObject({ description: "Hora real" });

      // Dentro del margen no hay ajuste ni conflicto.
      const id2 = randomUUID();
      const cerca = hora(60_000);
      await pushUno(panelA, upsert("controls", id2, { holder_id: hA, description: "Casi a tiempo" }, cerca));
      expect(Date.parse((await fila("controls", id2))!.updated_at as string)).toBe(Date.parse(cerca));
      expect(await conflictos(id2)).toEqual([]);
    });
  });

  describe("último en escribir gana (LWW)", () => {
    it("un updated_at anterior al de la nube queda superseded con conflicto lww y current; la fila no cambia", async () => {
      const R = await revisionInstalacion(inst1);
      const antes = await fila("cards", kA);
      const item = upsert("cards", kA, { card_code: 1001, holder_id: hA, description: "Vieja" }, hora(-60 * 60 * 1000));

      const r = await pushUno(panelA, item);
      expect(r).toEqual({
        change_id: item.change_id,
        status: "superseded",
        current: { data: { card_code: 1001, holder_id: hA, description: "Tarjeta Ana" } },
      });
      expect(await fila("cards", kA)).toEqual(antes);
      expect(await revisionInstalacion(inst1)).toBe(R);

      const [lww] = await conflictos(kA);
      expect(lww).toMatchObject({
        tenant_id: tenant1,
        installation_id: inst1,
        panel_id: panelA.id,
        table_name: "cards",
        row_id: kA,
        kind: "lww",
      });
      expect(lww.cloud_version).toMatchObject({ id: kA, description: "Tarjeta Ana" });
      expect(lww.panel_version).toMatchObject({ op: "upsert", data: { description: "Vieja" } });
      expect(lww.resolution).toEqual(expect.any(String));

      // Repetido: el mismo resultado, con current calculado de nuevo.
      expect(await pushUno(panelA, item)).toEqual(r);
      expect(await conflictos(kA)).toHaveLength(1);
    });

    it("en empate de updated_at gana la nube", async () => {
      const antes = await fila("cards", kA);
      const r = await pushUno(
        panelA,
        upsert("cards", kA, { card_code: 1001, holder_id: hA, description: "Empate" }, antes!.updated_at as string),
      );
      expect(r).toMatchObject({ status: "superseded", current: { data: { description: "Tarjeta Ana" } } });
      expect(await fila("cards", kA)).toEqual(antes);
    });

    it("un permiso más viejo que el de la nube recibe la proyección de ese panel como current", async () => {
      const r = await pushUno(
        panelB,
        upsert(
          "permissions",
          p0,
          { permission_id: 0, name: "Otro nombre", ...REGLA, output_mask: 15 },
          hora(-60 * 60 * 1000),
        ),
      );
      expect(r).toMatchObject({
        status: "superseded",
        current: { data: { permission_id: 0, name: "Residente", ...REGLA, output_mask: 2 } },
      });
      expect(await fila("access_profiles", p0)).toMatchObject({ name: "Residente" });
    });

    it("un upsert sobre un registro borrado en la nube queda superseded con current null y no lo revive", async () => {
      const id = await insertar("cards", { installation_id: inst1, card_code: 7201, holder_id: hA });
      await borrarEnLaNube("cards", id);
      const antes = await fila("cards", id);

      const tarjeta = { card_code: 7201, holder_id: hA, description: "Revivir" };
      const r = await pushUno(panelA, upsert("cards", id, tarjeta, hora(5000)));
      expect(r).toMatchObject({ status: "superseded", current: null });
      expect(await fila("cards", id)).toEqual(antes);
      expect((await conflictos(id)).map((c) => c.kind)).toEqual(["lww"]);
    });

    it("un delete sobre un registro ya borrado (o inexistente) queda applied sin efecto", async () => {
      const id = await insertar("cards", { installation_id: inst1, card_code: 7202, holder_id: hA });
      await borrarEnLaNube("cards", id);
      const antes = await fila("cards", id);
      const R = await revisionInstalacion(inst1);

      const r = await push(panelA, [borrado("cards", id), borrado("cards", randomUUID())]);
      expect(r.results.map(({ status, revision }) => ({ status, revision }))).toEqual([
        { status: "applied", revision: undefined },
        { status: "applied", revision: undefined },
      ]);
      expect(r.revision).toBe(R);
      expect(await fila("cards", id)).toEqual(antes);
    });

    it("un delete sobre un registro vivo más nuevo en la nube queda superseded con current", async () => {
      const id = await insertar("cards", {
        installation_id: inst1,
        card_code: 7203,
        holder_id: hA,
        description: "Sigue",
      });
      const r = await pushUno(panelA, borrado("cards", id, hora(-60 * 60 * 1000)));
      expect(r).toMatchObject({
        status: "superseded",
        current: { data: { card_code: 7203, holder_id: hA, description: "Sigue" } },
      });
      expect(await fila("cards", id)).toMatchObject({ deleted_at: null });
      expect((await conflictos(id)).map((c) => c.kind)).toEqual(["lww"]);
    });

    it("un delete más nuevo borra lógicamente con la cascada de N3", async () => {
      const h = await insertar("holders", { installation_id: inst1, kind: "domicilio", name: "Casa 9" });
      const k = await insertar("cards", { installation_id: inst1, card_code: 7204, holder_id: h });
      const r = await pushUno(panelA, borrado("holders", h));
      expect(r.status).toBe("applied");
      expect(r.revision).toBe(await revisionInstalacion(inst1));
      for (const [tabla, id] of [
        ["holders", h],
        ["cards", k],
      ]) {
        const borrada = await fila(tabla, id);
        expect(borrada!.deleted_at, tabla).not.toBeNull();
        expect(borrada!.origin, tabla).toBe(origenDe(panelA));
      }
    });
  });

  describe("unicidad y referencias", () => {
    it("un titular nuevo cuyo PIN ya tiene otro queda rejected con current null y sin guardar el PIN", async () => {
      const id = randomUUID();
      const item = upsert("holders", id, {
        kind: "persona",
        name: "Copia",
        department: "",
        address: "",
        notes: "",
        pin: PIN_ANA,
      });
      const r = await pushUno(panelA, item);
      expect(r).toEqual({ change_id: item.change_id, status: "rejected", reason: "duplicado", current: null });
      expect(await fila("holders", id)).toBeNull();

      const [unico, ...otros] = await conflictos(id);
      expect(otros).toEqual([]);
      expect(unico).toMatchObject({ kind: "unique", table_name: "holders", panel_id: panelA.id });
      expect(unico.cloud_version).toMatchObject({ id: hA, has_pin: true });
      expect(unico.panel_version).toMatchObject({ data: { name: "Copia", has_pin: true } });

      const [guardado] = await cambioGuardado(panelA.id, item.change_id);
      expect(guardado.result).toEqual({ status: "rejected", reason: "duplicado" });

      const ana = await fila("holders", hA);
      for (const texto of [JSON.stringify(unico), JSON.stringify(guardado)]) {
        expect(texto).not.toContain(PIN_ANA);
        expect(texto).not.toContain(ana!.pin_ciphertext as string);
        expect(texto).not.toContain(ana!.pin_lookup as string);
        expect(texto).not.toMatch(/"pin(_ciphertext|_lookup)?"/);
      }
    });

    it("un card_code o rf_code de otro registro queda rejected por duplicado, con conflicto unique", async () => {
      const nueva = randomUUID();
      const r1 = await pushUno(panelA, upsert("cards", nueva, { card_code: 1001, holder_id: hB, description: "" }));
      expect(r1).toMatchObject({ status: "rejected", reason: "duplicado", current: null });
      expect(await fila("cards", nueva)).toBeNull();
      const [c1] = await conflictos(nueva);
      expect(c1).toMatchObject({ kind: "unique", table_name: "cards" });
      expect(c1.cloud_version).toMatchObject({ id: kA, card_code: 1001 });

      // Una tarjeta que ya existe conserva su versión y la recibe en current.
      const propia = await insertar("cards", { installation_id: inst1, card_code: 7301, holder_id: hB });
      const antes = await fila("cards", propia);
      const cambio = { card_code: 1001, holder_id: hB, description: "" };
      const r2 = await pushUno(panelA, upsert("cards", propia, cambio, hora(5000)));
      expect(r2).toMatchObject({
        status: "rejected",
        reason: "duplicado",
        current: { data: { card_code: 7301, holder_id: hB, description: "" } },
      });
      expect(await fila("cards", propia)).toEqual(antes);

      const boton = randomUUID();
      const repetido = { control_id: kc, button: 1, rf_code: 5555, output_id: null };
      const r3 = await pushUno(panelA, upsert("control_buttons", boton, repetido));
      expect(r3).toMatchObject({ status: "rejected", reason: "duplicado", current: null });
      expect((await conflictos(boton)).map((c) => c.kind)).toEqual(["unique"]);
    });

    it("una tarjeta cuyo titular está borrado queda rejected con current", async () => {
      const h = await insertar("holders", { installation_id: inst1, kind: "persona", name: "Se fue" });
      await borrarEnLaNube("holders", h);

      const nueva = randomUUID();
      const r1 = await pushUno(panelA, upsert("cards", nueva, { card_code: 7401, holder_id: h, description: "" }));
      expect(r1).toMatchObject({ status: "rejected", reason: "relacionado no existe", current: null });
      expect(await fila("cards", nueva)).toBeNull();

      const viva = await insertar("cards", { installation_id: inst1, card_code: 7402, holder_id: hB });
      const antes = await fila("cards", viva);
      const aBorrado = { card_code: 7402, holder_id: h, description: "" };
      const r2 = await pushUno(panelA, upsert("cards", viva, aBorrado, hora(5000)));
      expect(r2).toMatchObject({
        status: "rejected",
        reason: "relacionado no existe",
        current: { data: { card_code: 7402, holder_id: hB, description: "" } },
      });
      expect(await fila("cards", viva)).toEqual(antes);

      // Un padre de otra instalación tampoco sirve (Riesgo 4).
      const ajena = randomUUID();
      const r3 = await pushUno(panelA, upsert("cards", ajena, { card_code: 7403, holder_id: x, description: "" }));
      expect(r3).toMatchObject({ status: "rejected", reason: "relacionado no existe", current: null });
      expect(await fila("cards", ajena)).toBeNull();
    });
  });

  describe("permisos, asignaciones y salidas", () => {
    it("permissions con permission_id 3 nuevo crea el perfil y la regla solo para ese panel", async () => {
      const id = randomUUID();
      const datos = { permission_id: 3, name: "Jardinero", ...REGLA, output_mask: 4, weekday_mask: 31 };
      const r = await pushUno(panelA, upsert("permissions", id, datos));
      expect(r.status).toBe("applied");
      expect(await fila("access_profiles", id)).toMatchObject({
        installation_id: inst1,
        name: "Jardinero",
        local_permission_id: 3,
        deleted_at: null,
        origin: origenDe(panelA),
      });
      const reglas = await filas("profile_panel_rules", "profile_id", id);
      expect(reglas).toHaveLength(1);
      expect(reglas[0]).toMatchObject({ panel_id: panelA.id, output_mask: 4, weekday_mask: 31, deleted_at: null });

      // El mismo permiso desde B: cambia el nombre del perfil y crea la regla de B.
      const deB = { ...datos, name: "Jardinería", output_mask: 8 };
      const r2 = await pushUno(panelB, upsert("permissions", id, deB, hora(3000)));
      expect(r2.status).toBe("applied");
      expect(await fila("access_profiles", id)).toMatchObject({ name: "Jardinería", local_permission_id: 3 });
      const despues = await filas("profile_panel_rules", "profile_id", id);
      expect(despues.map((x) => [x.panel_id, x.output_mask]).sort()).toEqual(
        [
          [panelA.id, 4],
          [panelB.id, 8],
        ].sort(),
      );
    });

    it("un permission_id distinto del perfil queda rejected con la versión de la nube", async () => {
      const antes = await fila("access_profiles", p0);
      const r = await pushUno(panelA, upsert("permissions", p0, { permission_id: 7, name: "Residente", ...REGLA }));
      expect(r).toMatchObject({
        status: "rejected",
        reason: "permission_id distinto",
        current: { data: { permission_id: 0, name: "Residente", ...REGLA } },
      });
      expect(await fila("access_profiles", p0)).toEqual(antes);
    });

    it("una regla borrada en la nube cuenta para LWW: gana si es más nueva y si no, se crea otra", async () => {
      const id = await insertar("access_profiles", { installation_id: inst1, name: "Visitas", local_permission_id: 6 });
      const reglaA = await regla(inst1, id, panelA.id);
      await borrarEnLaNube("profile_panel_rules", reglaA);

      const permiso = { permission_id: 6, name: "Visitas", ...REGLA };
      const viejo = await pushUno(panelA, upsert("permissions", id, permiso, hora(-60_000)));
      expect(viejo).toMatchObject({
        status: "superseded",
        current: {
          data: {
            permission_id: 6,
            name: "Visitas",
            output_mask: 0,
            card_reader_mask: 0,
            pin_reader_mask: 0,
            allow_rf: false,
            weekday_mask: 0,
            start_minute: 0,
            end_minute: 0,
          },
        },
      });
      expect((await filas("profile_panel_rules", "profile_id", id)).filter((x) => x.deleted_at === null)).toEqual([]);

      const nuevo = await pushUno(panelA, upsert("permissions", id, permiso, hora(5000)));
      expect(nuevo.status).toBe("applied");
      const vivas = (await filas("profile_panel_rules", "profile_id", id)).filter((x) => x.deleted_at === null);
      expect(vivas).toHaveLength(1);
      expect(vivas[0]).toMatchObject({ panel_id: panelA.id, ...REGLA });
      expect(vivas[0].id).not.toBe(reglaA);
    });

    it("un permission_id nuevo que ya usa otro perfil queda rejected", async () => {
      const id = randomUUID();
      const r = await pushUno(panelA, upsert("permissions", id, { permission_id: 0, name: "Choque", ...REGLA }));
      expect(r).toMatchObject({ status: "rejected", reason: "duplicado", current: null });
      expect(await fila("access_profiles", id)).toBeNull();
      expect((await conflictos(id)).map((c) => c.kind)).toEqual(["unique"]);
    });

    it("un delete de permissions borra el perfil, sus asignaciones y sus reglas en todos los paneles", async () => {
      const r = await pushUno(panelA, borrado("permissions", pX));
      expect(r.status).toBe("applied");
      expect(await fila("access_profiles", pX)).toMatchObject({ origin: origenDe(panelA) });
      expect((await fila("access_profiles", pX))!.deleted_at).not.toBeNull();
      const reglas = await filas("profile_panel_rules", "profile_id", pX);
      const asignaciones = await filas("holder_profiles", "profile_id", pX);
      expect(reglas.map((x) => x.panel_id).sort()).toEqual([panelA.id, panelB.id].sort());
      expect(asignaciones).toHaveLength(2);
      for (const hija of [...reglas, ...asignaciones]) expect(hija.deleted_at).not.toBeNull();
    });

    it("holder_permissions se traduce a holder_profiles por permission_id", async () => {
      const id = randomUUID();
      const r = await pushUno(panelA, upsert("holder_permissions", id, { holder_id: hB, permission_id: 0 }));
      expect(r.status).toBe("applied");
      expect(await fila("holder_profiles", id)).toMatchObject({
        installation_id: inst1,
        holder_id: hB,
        profile_id: p0,
        deleted_at: null,
      });

      const sinPerfil = randomUUID();
      const r2 = await pushUno(panelA, upsert("holder_permissions", sinPerfil, { holder_id: hB, permission_id: 30 }));
      expect(r2).toMatchObject({ status: "rejected", reason: "relacionado no existe", current: null });
      expect(await fila("holder_profiles", sinPerfil)).toBeNull();

      const viejo = await pushUno(
        panelA,
        upsert("holder_permissions", hp0, { holder_id: hA, permission_id: 0 }, hora(-60 * 60 * 1000)),
      );
      expect(viejo).toMatchObject({ status: "superseded", current: { data: { holder_id: hA, permission_id: 0 } } });

      // Mover la asignación a otro titular; a uno que ya tiene ese perfil es un duplicado.
      const aAna = { holder_id: hA, permission_id: 0 };
      const yaLoTiene = await pushUno(panelA, upsert("holder_permissions", id, aAna, hora(2000)));
      expect(yaLoTiene).toMatchObject({
        status: "rejected",
        reason: "duplicado",
        current: { data: { holder_id: hB } },
      });
      const hC = await insertar("holders", { installation_id: inst1, kind: "persona", name: "Carla" });
      const aCarla = { holder_id: hC, permission_id: 0 };
      const movida = await pushUno(panelA, upsert("holder_permissions", id, aCarla, hora(2000)));
      expect(movida.status).toBe("applied");
      expect(await fila("holder_profiles", id)).toMatchObject({ holder_id: hC, profile_id: p0 });

      expect((await pushUno(panelA, borrado("holder_permissions", id, hora(3000)))).status).toBe("applied");
      expect((await fila("holder_profiles", id))!.deleted_at).not.toBeNull();
    });

    it("outputs actualiza la salida de ese panel, nunca la de otro panel", async () => {
      const datos = { output_id: 1, alias: "Pluma", duration_ms: 1500, reader_mask: 3, enabled: false };
      const r = await pushUno(panelA, upsert("outputs", salidasA[1], datos));
      expect(r.status).toBe("applied");
      expect(await fila("outputs", salidasA[1])).toMatchObject({
        panel_id: panelA.id,
        output_index: 1,
        alias: "Pluma",
        duration_ms: 1500,
        reader_mask: 3,
        enabled: false,
      });

      const deB = await fila("outputs", salidasB[1]);
      const r2 = await pushUno(panelA, upsert("outputs", salidasB[1], datos));
      expect(r2).toMatchObject({ status: "rejected", reason: "no encontrado", current: null });
      expect(await fila("outputs", salidasB[1])).toEqual(deB);

      // Una salida que la nube no tiene se da de alta en ese panel.
      expect((await pushUno(panelA, borrado("outputs", salidasA[3]))).status).toBe("applied");
      const nueva = randomUUID();
      const r3 = await pushUno(panelA, upsert("outputs", nueva, { ...datos, output_id: 3, alias: "Peatonal" }));
      expect(r3.status).toBe("applied");
      expect(await fila("outputs", nueva)).toMatchObject({
        installation_id: inst1,
        panel_id: panelA.id,
        output_index: 3,
        alias: "Peatonal",
        origin: origenDe(panelA),
      });
    });
  });

  describe("Riesgo 4: datos de otra instalación", () => {
    it("un panel no puede modificar ni borrar registros de otra instalación", async () => {
      const ids: [TableName, string, string][] = [
        ["holders", "holders", hA],
        ["cards", "cards", kA],
        ["controls", "controls", kc],
        ["control_buttons", "control_buttons", kb],
        ["permissions", "access_profiles", p0],
        ["holder_permissions", "holder_profiles", hp0],
        ["outputs", "outputs", salidasA[0]],
      ];
      const antes = await Promise.all(ids.map(([, origen, id]) => fila(origen, id)));
      const R1 = await revisionInstalacion(inst1);
      const R2 = await revisionInstalacion(inst2);

      const datos: { [T in TableName]: TableData[T] } = {
        holders: { kind: "persona", name: "Intruso", department: "", address: "", notes: "", pin: null },
        cards: { card_code: 9901, holder_id: x, description: "" },
        controls: { holder_id: x, description: "" },
        control_buttons: { control_id: kc, button: 3, rf_code: 9902, output_id: null },
        permissions: { permission_id: 9, name: "Intruso", ...REGLA },
        holder_permissions: { holder_id: x, permission_id: 0 },
        outputs: { output_id: 0, alias: "Intruso", duration_ms: 1, reader_mask: 0, enabled: false },
      };
      const items = ids.flatMap(([tabla, , id]) => [
        upsert(tabla, id, datos[tabla], hora(5000)),
        borrado(tabla, id, hora(6000)),
      ]);
      const r = await push(panelC, items);
      for (const [i, resultado] of r.results.entries()) {
        expect(resultado, `${items[i].table} ${items[i].op}`).toEqual({
          change_id: items[i].change_id,
          status: "rejected",
          reason: "no encontrado",
          current: null,
        });
      }
      expect(r.revision).toBe(R2);
      expect(await revisionInstalacion(inst1)).toBe(R1);
      expect(await revisionInstalacion(inst2)).toBe(R2);
      expect(await Promise.all(ids.map(([, origen, id]) => fila(origen, id)))).toEqual(antes);
    });
  });

  describe("validación y acceso", () => {
    it("un lote vacío responde la revisión actual sin resultados", async () => {
      expect(await push(panelA, [])).toEqual({ revision: await revisionInstalacion(inst1), results: [] });
    });

    it("cuerpos inválidos responden 400 invalid_body sin aplicar nada", async () => {
      const R = await revisionInstalacion(inst1);
      const base = upsert("cards", randomUUID(), { card_code: 7501, holder_id: hA, description: "" });
      const sinData: Fila = { ...base };
      delete sinData.data;
      const titular = { kind: "persona", name: "Ana", department: "", address: "", notes: "", pin: null };
      const invalidos: unknown[] = [
        "{no es json",
        {},
        { changes: "x" },
        { changes: [sinData] },
        { changes: [{ ...base, data: { card_code: 7501, holder_id: hA, description: "", extra: 1 } }] },
        { changes: [{ ...base, updated_at: "ayer" }] },
        { changes: [{ ...base, updated_at: "2026-10-27 05:00:00" }] },
        { changes: [{ ...base, id: base.id.toUpperCase() }] },
        { changes: [{ ...base, table: "panels" }] },
        { changes: [{ ...base, op: "insert" }] },
        { changes: [{ ...base, change_id: "" }] },
        { changes: [{ ...base, table: "holders", data: { ...titular, name: "   " } }] },
        { changes: [{ ...base, table: "holders", data: { ...titular, pin: "12" } }] },
        { changes: Array.from({ length: CHANGES_PAGE + 1 }, () => borrado("cards", randomUUID())) },
      ];
      for (const cuerpo of invalidos) {
        const res = await postChanges(peticion("changes", panelA, cuerpo));
        expect(res.status, JSON.stringify(cuerpo).slice(0, 120)).toBe(400);
        expect(await res.json()).toEqual({ code: "invalid_body", message: expect.any(String) });
      }
      expect(await revisionInstalacion(inst1)).toBe(R);
      expect(await fila("cards", base.id)).toBeNull();
    });

    it("un lote de CHANGES_PAGE cambios se acepta", { timeout: 60_000 }, async () => {
      const r = await push(
        panelA,
        Array.from({ length: CHANGES_PAGE }, () => borrado("cards", randomUUID())),
      );
      expect(r.results).toHaveLength(CHANGES_PAGE);
      expect(new Set(r.results.map((x) => x.status))).toEqual(new Set(["applied"]));
    });

    it("el nombre del titular sigue la CHECK local (trim de SQLite: solo quita espacios)", async () => {
      const id = randomUUID();
      const r = await pushUno(
        panelA,
        upsert("holders", id, { kind: "domicilio", name: "\t", department: "", address: "", notes: "", pin: null }),
      );
      expect(r.status).toBe("applied");
      expect(await fila("holders", id)).toMatchObject({ name: "\t" });
    });

    it("sin credencial responde 401 y un panel que no está activo, 409 not_active", async () => {
      const cuerpo = { changes: [] };
      const sin = await postChanges(peticion("changes", undefined, cuerpo));
      expect(sin.status).toBe(401);
      expect(await sin.json()).toMatchObject({ code: "unauthorized" });
      const staging = await postChanges(peticion("changes", panelS, cuerpo));
      expect(staging.status).toBe(409);
      expect(await staging.json()).toEqual({ code: "not_active", message: expect.any(String) });
    });
  });
});

describe("retryOnDeadlock", () => {
  const interbloqueo = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

  it("reintenta ante 40P01 hasta 3 veces y devuelve el resultado", async () => {
    let llamadas = 0;
    const valor = await retryOnDeadlock(async () => {
      llamadas++;
      if (llamadas <= 3) throw interbloqueo();
      return "ok";
    });
    expect(valor).toBe("ok");
    expect(llamadas).toBe(4);
  });

  it("después de 3 reintentos, o ante otro error, lanza el error", async () => {
    let llamadas = 0;
    await expect(
      retryOnDeadlock(async () => {
        llamadas++;
        throw interbloqueo();
      }),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(llamadas).toBe(4);

    llamadas = 0;
    await expect(
      retryOnDeadlock(async () => {
        llamadas++;
        throw Object.assign(new Error("otro"), { code: "23505" });
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(llamadas).toBe(1);
  });
});
