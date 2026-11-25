import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getChanges, POST as postChanges } from "@/app/api/device/v1/changes/route";
import { GET as getChecksums } from "@/app/api/device/v1/checksums/route";
import { POST as importSnapshot } from "@/app/api/device/v1/import-snapshot/route";
import { GET as getSnapshot } from "@/app/api/device/v1/snapshot/route";
import { authenticateDevice } from "@/lib/device/auth";
import { tableChecksum } from "@/lib/device/checksum";
import { confirmImportAs, readImportDiffAs } from "@/lib/device/imports";
import type { ChangeItem, PullResponse, PushResponse, TableName } from "@/lib/device/contract";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

// Integración contra el Supabase LOCAL: teléfonos y configuración de llamadas en la bajada
// (feed, checksums y snapshot), la subida y la importación, según `X-Acc-Schema`.

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

function cabeceras(panel: PanelPrueba, schema?: number): Record<string, string> {
  const h: Record<string, string> = { authorization: `Device ${panel.code}.${panel.token}` };
  if (schema !== undefined) h["x-acc-schema"] = String(schema);
  return h;
}

const peticion = (ruta: string, panel: PanelPrueba, schema?: number) =>
  new Request(`${URL_BASE}/${ruta}`, { headers: cabeceras(panel, schema) });

async function pull(panel: PanelPrueba, since: number, schema?: number): Promise<PullResponse> {
  const res = await getChanges(peticion(`changes?since=${since}`, panel, schema));
  expect(res.status).toBe(200);
  return res.json();
}

async function snapshot(panel: PanelPrueba, tabla: TableName, schema?: number): Promise<Snapshot> {
  const res = await getSnapshot(peticion(`snapshot?table=${tabla}`, panel, schema));
  expect(res.status).toBe(200);
  return res.json();
}

async function checksums(panel: PanelPrueba, schema?: number) {
  const res = await getChecksums(peticion("checksums", panel, schema));
  expect(res.status).toBe(200);
  return (await res.json()) as { revision: number; tables: Record<string, string> };
}

async function push(panel: PanelPrueba, changes: unknown[], schema = 8) {
  return postChanges(
    new Request(`${URL_BASE}/changes`, {
      method: "POST",
      headers: { ...cabeceras(panel, schema), "content-type": "application/json" },
      body: JSON.stringify({ changes }),
    }),
  );
}

const tablas = (r: PullResponse) => new Set(r.changes.map((c) => c.table));
const de = (r: PullResponse, tabla: TableName) => r.changes.filter((c) => c.table === tabla);

describe("apertura por llamada en la sincronización", () => {
  const corrida = base32(6).toLowerCase();
  let admin: SupabaseClient;
  const tenants: string[] = [];
  const usuarios: string[] = [];
  const paneles: string[] = [];
  let inst: string;
  let instVacia: string;
  let panelA: PanelPrueba;
  let h1: string;
  let f1: string;
  let f2: string;
  let fBorrado: string;
  let perfil: string;

  const autor = () => ({ updated_at: new Date().toISOString(), updated_by: "prueba", origin: "cloud" });

  async function insertar(tabla: string, fila: Record<string, unknown>): Promise<string> {
    const { data, error } = await admin
      .from(tabla)
      .insert({ ...fila, ...autor() })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }

  async function revisionDe(tabla: string, id: string): Promise<number> {
    const { data, error } = await admin.from(tabla).select("revision").eq("id", id).single();
    if (error) throw error;
    return data.revision;
  }

  async function revisionInstalacion(id: string): Promise<number> {
    const { data, error } = await admin.from("installations").select("revision").eq("id", id).single();
    if (error) throw error;
    return data.revision;
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

  async function ajustesDe(panelId: string) {
    const { data, error } = await admin
      .from("panel_call_settings")
      .select("*")
      .eq("panel_id", panelId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    return data as Record<string, unknown> | null;
  }

  async function cambiarAjustes(panelId: string, cambios: Record<string, unknown>) {
    const { error } = await admin
      .from("panel_call_settings")
      .update({ ...cambios, ...autor() })
      .eq("panel_id", panelId)
      .is("deleted_at", null);
    if (error) throw error;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();
    const { data: t, error: e1 } = await admin
      .from("tenants")
      .insert({ name: `Llamadas ${corrida}` })
      .select("id")
      .single<{ id: string }>();
    if (e1) throw e1;
    tenants.push(t.id);
    const { data: is, error: e2 } = await admin
      .from("installations")
      .insert([
        { tenant_id: t.id, name: `Llamadas 1 ${corrida}` },
        { tenant_id: t.id, name: `Llamadas 2 ${corrida}` },
      ])
      .select("id, name");
    if (e2) throw e2;
    inst = is.find((i) => i.name.startsWith("Llamadas 1"))!.id;
    instVacia = is.find((i) => i.name.startsWith("Llamadas 2"))!.id;
    panelA = await crearPanel(inst);
    await insertar("panel_call_settings", { installation_id: inst, panel_id: panelA.id });
    const i1 = { installation_id: inst };
    h1 = await insertar("holders", { ...i1, kind: "persona", name: "Ana" });
    f1 = await insertar("phones", { ...i1, holder_id: h1, number: "5512345678", description: "Celular" });
    f2 = await insertar("phones", { ...i1, holder_id: h1, number: "5587654321" });
    fBorrado = await insertar("phones", { ...i1, holder_id: h1, number: "5500000000" });
    const { error } = await admin
      .from("phones")
      .update({ deleted_at: new Date().toISOString(), ...autor() })
      .eq("id", fBorrado);
    if (error) throw error;
    perfil = await insertar("access_profiles", { ...i1, name: "Residente", local_permission_id: 0 });
    await insertar("profile_panel_rules", {
      ...i1,
      profile_id: perfil,
      panel_id: panelA.id,
      output_mask: 1,
      card_reader_mask: 0,
      pin_reader_mask: 0,
      allow_rf: false,
      allow_call: true,
      weekday_mask: 127,
      start_minute: 0,
      end_minute: 1439,
    });
  });

  afterAll(async () => {
    if (!admin) return;
    for (const u of usuarios) await admin.auth.admin.deleteUser(u);
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

  it("auth lee X-Acc-Schema", async () => {
    const leer = async (valor?: string) => {
      const headers: Record<string, string> = { authorization: `Device ${panelA.code}.${panelA.token}` };
      if (valor !== undefined) headers["x-acc-schema"] = valor;
      return (await authenticateDevice(new Request(`${URL_BASE}/checksums`, { headers }))).schema;
    };
    expect(await leer("8")).toBe(8);
    expect(await leer()).toBe(7);
    expect(await leer("abc")).toBe(7);
    expect(await leer("8.5")).toBe(7);
  });

  it("listChanges omite phones a panel v7", async () => {
    await cambiarAjustes(panelA.id, { enabled: true });
    const r = await pull(panelA, 0);
    expect(tablas(r).has("phones")).toBe(false);
    expect(tablas(r).has("call_settings" as TableName)).toBe(false);
    const permisos = de(r, "permissions") as Extract<ChangeItem, { op: "upsert" }>[];
    expect(permisos).toHaveLength(1);
    expect(permisos[0].data).not.toHaveProperty("allow_call");
    expect(permisos[0].data).toHaveProperty("allow_remote");
  });

  it("permissions de panel v7 sin allow_call (y v8 con allow_call)", async () => {
    const v7 = await snapshot(panelA, "permissions");
    expect(v7.rows[0].data).not.toHaveProperty("allow_call");
    const v8 = await snapshot(panelA, "permissions", 8);
    expect(v8.rows[0].data.allow_call).toBe(true);
    const sumas = await checksums(panelA);
    expect(Object.keys(sumas.tables)).not.toContain("phones");
    expect(Object.keys(sumas.tables)).not.toContain("call_settings");
    expect(sumas.tables.permissions).toBe(tableChecksum(v7.rows));
  });

  it("listChanges omite phones con módulo desactivado", async () => {
    await cambiarAjustes(panelA.id, { enabled: false });
    const r = await pull(panelA, 0, 8);
    expect(de(r, "phones").filter((c) => c.op === "upsert")).toEqual([]);
    const ajustes = de(r, "call_settings" as TableName) as Extract<ChangeItem, { op: "upsert" }>[];
    expect(ajustes).toHaveLength(1);
    expect(ajustes[0].data).toMatchObject({ enabled: false, output_id: 0, mode: "single" });
    expect(ajustes[0].data).not.toHaveProperty("output_index");
  });

  it("snapshot de phones vacío con módulo desactivado", async () => {
    expect((await snapshot(panelA, "phones", 8)).rows).toEqual([]);
    for (const tabla of ["phones", "call_settings"] as TableName[]) {
      const v7 = await getSnapshot(peticion(`snapshot?table=${tabla}`, panelA));
      expect(v7.status).toBe(400);
      expect((await v7.json()).code).toBe("invalid_query");
    }
    const s = await snapshot(panelA, "call_settings" as TableName, 8);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].data.enabled).toBe(false);
  });

  it("activar el módulo emite todos los teléfonos vivos con la revisión del cambio", async () => {
    const antes = await revisionInstalacion(inst);
    await cambiarAjustes(panelA.id, { enabled: true, output_index: 2 });
    const ajustes = await ajustesDe(panelA.id);
    const rev = await revisionDe("panel_call_settings", ajustes!.id as string);
    const r = await pull(panelA, antes, 8);
    const tel = de(r, "phones");
    expect(tel.map((c) => c.id).sort()).toEqual([f1, f2].sort());
    expect(tel.every((c) => c.op === "upsert" && c.revision === rev)).toBe(true);
    const f1data = (tel.find((c) => c.id === f1) as Extract<ChangeItem, { op: "upsert" }>).data;
    expect(f1data).toEqual({ holder_id: h1, number: "5512345678", description: "Celular" });
    const cs = de(r, "call_settings" as TableName) as Extract<ChangeItem, { op: "upsert" }>[];
    expect(cs[0]).toMatchObject({ id: ajustes!.id, revision: rev, data: { enabled: true, output_id: 2 } });
    // Un panel v7 no ve nada de esto.
    expect((await pull(panelA, antes)).changes).toEqual([]);
  });

  it("una página de un solo cambio de la configuración trae los teléfonos anteriores al cambio", async () => {
    const antes = await revisionInstalacion(inst);
    await cambiarAjustes(panelA.id, { call_limit_per_minute: 4 });
    await admin.from("phones").update({ description: "Celular 2", ...autor() }).eq("id", f1);
    const res = await getChanges(peticion(`changes?since=${antes}&limit=1`, panelA, 8));
    const r = (await res.json()) as PullResponse;
    expect(r.has_more).toBe(true);
    // f1 cambió después de la configuración: no sale aquí (su titular podría llegar después);
    // su cambio propio queda para la página siguiente (el corte es por cambios de origen).
    expect(de(r, "phones").map((c) => c.id)).toEqual([f2]);
    const siguiente = await pull(panelA, r.revision, 8);
    expect(de(siguiente, "phones")).toMatchObject([{ id: f1, op: "upsert", data: { description: "Celular 2" } }]);
    await admin.from("phones").update({ description: "Celular", ...autor() }).eq("id", f1);
  });

  it("con el módulo activado, los cambios de phones viajan al panel v8", async () => {
    const antes = await revisionInstalacion(inst);
    await admin
      .from("phones")
      .update({ description: "Casa", ...autor() })
      .eq("id", f2);
    const r = await pull(panelA, antes, 8);
    expect(de(r, "phones")).toMatchObject([{ id: f2, op: "upsert", data: { description: "Casa" } }]);
  });

  it("checksums de panel v8 activado incluye phones y call_settings", async () => {
    const sumas = await checksums(panelA, 8);
    const tel = await snapshot(panelA, "phones", 8);
    expect(tel.rows.map((f) => f.id).sort()).toEqual([f1, f2].sort());
    expect(sumas.tables.phones).toBe(tableChecksum(tel.rows));
    const cs = await snapshot(panelA, "call_settings" as TableName, 8);
    expect(sumas.tables.call_settings).toBe(tableChecksum(cs.rows));
    const perm = await snapshot(panelA, "permissions", 8);
    expect(sumas.tables.permissions).toBe(tableChecksum(perm.rows));
  });

  it("desactivar emite delete de todos los teléfonos", async () => {
    const antes = await revisionInstalacion(inst);
    await cambiarAjustes(panelA.id, { enabled: false });
    const rev = await revisionDe("panel_call_settings", (await ajustesDe(panelA.id))!.id as string);
    const r = await pull(panelA, antes, 8);
    const tel = de(r, "phones");
    expect(tel.map((c) => c.id).sort()).toEqual([f1, f2, fBorrado].sort());
    expect(tel.every((c) => c.op === "delete" && c.revision === rev)).toBe(true);
    // Un cambio de un teléfono con el módulo apagado no se emite.
    const antes2 = await revisionInstalacion(inst);
    await admin.from("phones").update({ description: "Otra", ...autor() }).eq("id", f1);
    expect(de(await pull(panelA, antes2, 8), "phones")).toEqual([]);
  });

  it("crea la configuración del panel si falta", async () => {
    const panelN = await crearPanel(inst);
    expect(await ajustesDe(panelN.id)).toBeNull();
    const sumas = await checksums(panelN, 8);
    expect(sumas.tables.call_settings).toBeDefined();
    expect(await ajustesDe(panelN.id)).not.toBeNull();
  });

  describe("subida de call_settings", () => {
    const datos = {
      enabled: true,
      mode: "menu",
      output_id: 1,
      menu_mask: 3,
      default_output: 1,
      call_limit_per_minute: 5,
    };
    const cambio = (data: unknown, updated_at = new Date().toISOString()) => ({
      change_id: randomUUID().replaceAll("-", ""),
      table: "call_settings",
      op: "upsert",
      id: randomUUID(),
      updated_at,
      data,
    });

    it("rechaza una predeterminada fuera del menú con 400 sin escribir nada", async () => {
      const res = await push(panelA, [cambio({ ...datos, default_output: 2 })]);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_body");
    });

    it("rechaza un número de teléfono inválido con 400", async () => {
      const res = await push(panelA, [
        {
          change_id: randomUUID().replaceAll("-", ""),
          table: "phones",
          op: "upsert",
          id: randomUUID(),
          updated_at: new Date().toISOString(),
          data: { holder_id: h1, number: "123", description: "" },
        },
      ]);
      expect(res.status).toBe(400);
    });

    it("aplica a la fila del panel y responde current con output_id", async () => {
      const res = await push(panelA, [cambio(datos)]);
      expect(res.status).toBe(200);
      const r = (await res.json()) as PushResponse;
      expect(r.results[0].status).toBe("applied");
      expect(await ajustesDe(panelA.id)).toMatchObject({ output_index: 1, menu_mask: 3, call_limit_per_minute: 5 });
      // Un cambio viejo pierde y trae la versión vigente en la forma del contrato.
      const viejo = await push(panelA, [cambio({ ...datos, enabled: false }, "2020-01-01T00:00:00.000Z")]);
      const rv = (await viejo.json()) as PushResponse;
      expect(rv.results[0].status).toBe("superseded");
      expect(rv.results[0].current).toEqual({ data: datos });
    });
  });

  describe("importación", () => {
    const vacias = () => ({
      holders: [],
      cards: [],
      controls: [],
      control_buttons: [],
      permissions: [],
      holder_permissions: [],
      outputs: [],
    });

    async function importar(panel: PanelPrueba, tables: unknown, schema?: number) {
      return importSnapshot(
        new Request(`${URL_BASE}/import-snapshot`, {
          method: "POST",
          headers: { ...cabeceras(panel, schema), "content-type": "application/json" },
          body: JSON.stringify({ tables }),
        }),
      );
    }

    it("importación de panel v7 sin phones", async () => {
      const { data: i, error } = await admin
        .from("installations")
        .insert({ tenant_id: tenants[0], name: `Llamadas 3 ${corrida}` })
        .select("id")
        .single<{ id: string }>();
      if (error) throw error;
      const panel = await crearPanel(i.id, "staging");
      const res = await importar(panel, vacias());
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "active" });
      expect(await ajustesDe(panel.id)).toMatchObject({ enabled: false });
    });

    it("importación de panel v8 con teléfonos y configuración", async () => {
      const panel = await crearPanel(instVacia, "staging");
      const titular = randomUUID();
      const telefono = randomUUID();
      const tables = {
        ...vacias(),
        holders: [
          {
            id: titular,
            data: { kind: "persona", name: "Luis", department: "", address: "", notes: "", pin: null },
          },
        ],
        phones: [{ id: telefono, data: { holder_id: titular, number: "5511112222", description: "Cel" } }],
        call_settings: [
          {
            id: randomUUID(),
            data: {
              enabled: true,
              mode: "menu",
              output_id: 3,
              menu_mask: 12,
              default_output: 2,
              call_limit_per_minute: 7,
            },
          },
        ],
      };
      const res = await importar(panel, tables, 8);
      expect(res.status).toBe(202);
      const { data: f } = await admin.from("phones").select("holder_id, number").eq("id", telefono).single();
      expect(f).toEqual({ holder_id: titular, number: "5511112222" });
      expect(await ajustesDe(panel.id)).toMatchObject({
        enabled: true,
        mode: "menu",
        output_index: 3,
        menu_mask: 12,
        default_output: 2,
        call_limit_per_minute: 7,
      });
    });

    it("rechaza un snapshot con un teléfono de un titular que no está", async () => {
      const panel = await crearPanel(instVacia, "staging");
      const res = await importar(
        panel,
        { ...vacias(), phones: [{ id: randomUUID(), data: { holder_id: randomUUID(), number: "5599998888", description: "" } }] },
        8,
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_snapshot");
    });

    it("confirmar importa los teléfonos de los titulares que quedan y no repite números", async () => {
      const correo = `llamadas-${corrida}@example.com`;
      const password = `Clave-${corrida}-123`;
      const usuario = await createLocalUser(admin, correo, password);
      usuarios.push(usuario);
      const { error: em } = await admin
        .from("tenant_members")
        .insert({ tenant_id: tenants[0], user_id: usuario, role: "admin" });
      if (em) throw em;
      const { data: i, error } = await admin
        .from("installations")
        .insert({ tenant_id: tenants[0], name: `Llamadas 4 ${corrida}` })
        .select("id")
        .single<{ id: string }>();
      if (error) throw error;
      const beto = await insertar("holders", { installation_id: i.id, kind: "persona", name: "Beto" });
      await insertar("phones", { installation_id: i.id, holder_id: beto, number: "5500001111" });
      const panel = await crearPanel(i.id, "staging");

      const titular = (name: string) => ({
        id: randomUUID(),
        data: { kind: "persona", name, department: "", address: "", notes: "", pin: null },
      });
      const sBeto = titular("Beto");
      const fer = titular("Fer");
      const gil = titular("Gil");
      const tel = (holder_id: string, number: string) => ({
        id: randomUUID(),
        data: { holder_id, number, description: "" },
      });
      const repetido = tel(sBeto.id, "5500001111");
      const deBeto = tel(sBeto.id, "5500002222");
      const deFer = tel(fer.id, "5500003333");
      const deGil = tel(gil.id, "5500004444");
      const res = await importar(
        panel,
        {
          ...vacias(),
          holders: [sBeto, fer, gil],
          phones: [repetido, deBeto, deFer, deGil],
          call_settings: [
            {
              id: randomUUID(),
              data: { enabled: true, mode: "single", output_id: 1, menu_mask: 0, default_output: null, call_limit_per_minute: 3 },
            },
          ],
        },
        8,
      );
      expect(await res.json()).toEqual({ status: "awaiting_review" });
      const cliente = await signInLocal(correo, password);
      expect((await readImportDiffAs(cliente, panel.id)).onlyInPanel.map((x) => x.id).sort()).toEqual(
        [fer.id, gil.id].sort(),
      );
      await confirmImportAs(cliente, panel.id, [fer.id]);
      const { data: filas, error: ef } = await admin
        .from("phones")
        .select("holder_id, number")
        .eq("installation_id", i.id)
        .is("deleted_at", null)
        .order("number");
      if (ef) throw ef;
      expect(filas).toEqual([
        { holder_id: beto, number: "5500001111" },
        { holder_id: beto, number: "5500002222" },
        { holder_id: fer.id, number: "5500003333" },
      ]);
      expect(await ajustesDe(panel.id)).toMatchObject({ enabled: true, output_index: 1 });
    });
  });
});
