import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GET as getChanges,
  POST as postChanges,
} from "@/app/api/device/v1/changes/route";
import { GET as getChecksums } from "@/app/api/device/v1/checksums/route";
import { POST as importSnapshot } from "@/app/api/device/v1/import-snapshot/route";
import { GET as getSnapshot } from "@/app/api/device/v1/snapshot/route";
import { tableChecksum } from "@/lib/device/checksum";
import type {
  ChangeItem,
  PullResponse,
  PushResponse,
  TableName,
} from "@/lib/device/contract";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Integración contra el Supabase LOCAL: QR y ajustes de QR en la bajada (feed, checksums y
// snapshot), la subida y la importación, según `X-Acc-Schema` (9).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) =>
  Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
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

function cabeceras(
  panel: PanelPrueba,
  schema?: number,
): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Device ${panel.code}.${panel.token}`,
  };
  if (schema !== undefined) h["x-acc-schema"] = String(schema);
  return h;
}

const peticion = (ruta: string, panel: PanelPrueba, schema?: number) =>
  new Request(`${URL_BASE}/${ruta}`, { headers: cabeceras(panel, schema) });

async function pull(
  panel: PanelPrueba,
  since: number,
  schema?: number,
): Promise<PullResponse> {
  const res = await getChanges(
    peticion(`changes?since=${since}`, panel, schema),
  );
  expect(res.status).toBe(200);
  return res.json();
}

async function snapshot(
  panel: PanelPrueba,
  tabla: TableName,
  schema?: number,
): Promise<Snapshot> {
  const res = await getSnapshot(
    peticion(`snapshot?table=${tabla}`, panel, schema),
  );
  expect(res.status).toBe(200);
  return res.json();
}

async function checksums(panel: PanelPrueba, schema?: number) {
  const res = await getChecksums(peticion("checksums", panel, schema));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    revision: number;
    tables: Record<string, string>;
  };
}

async function push(panel: PanelPrueba, changes: unknown[], schema = 9) {
  return postChanges(
    new Request(`${URL_BASE}/changes`, {
      method: "POST",
      headers: {
        ...cabeceras(panel, schema),
        "content-type": "application/json",
      },
      body: JSON.stringify({ changes }),
    }),
  );
}

const tablas = (r: PullResponse) => new Set(r.changes.map((c) => c.table));
const de = (r: PullResponse, tabla: TableName) =>
  r.changes.filter((c) => c.table === tabla);

describe("códigos QR en la sincronización", () => {
  const corrida = base32(6).toLowerCase();
  let admin: SupabaseClient;
  const tenants: string[] = [];
  const paneles: string[] = [];
  let inst: string;
  let panelA: PanelPrueba;
  let h1: string;
  let q1: string;
  let perfil: string;

  const autor = () => ({
    updated_at: new Date().toISOString(),
    updated_by: "prueba",
    origin: "cloud",
  });

  async function insertar(
    tabla: string,
    fila: Record<string, unknown>,
  ): Promise<string> {
    const { data, error } = await admin
      .from(tabla)
      .insert({ ...fila, ...autor() })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }

  async function revisionInstalacion(id: string): Promise<number> {
    const { data, error } = await admin
      .from("installations")
      .select("revision")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data.revision;
  }

  async function crearInstalacion(nombre: string): Promise<string> {
    const { data, error } = await admin
      .from("installations")
      .insert({ tenant_id: tenants[0], name: `${nombre} ${corrida}` })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }

  async function crearPanel(
    installationId: string,
    status = "active",
  ): Promise<PanelPrueba> {
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

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();
    const { data: t, error } = await admin
      .from("tenants")
      .insert({ name: `QR ${corrida}` })
      .select("id")
      .single();
    if (error) throw error;
    tenants.push(t.id);
    inst = await crearInstalacion("QR 1");
    panelA = await crearPanel(inst);
    h1 = await insertar("holders", {
      installation_id: inst,
      kind: "persona",
      name: "Ana",
    });
    q1 = await insertar("qr_codes", {
      installation_id: inst,
      holder_id: h1,
      code: 912345678,
      label: "Visita",
      valid_from: "2026-11-26T08:00:00.400Z",
      valid_until: "2099-01-01T00:00:00Z",
      created_at: "2026-11-26T07:00:00Z",
      max_uses: 2,
    });
    perfil = await insertar("access_profiles", {
      installation_id: inst,
      name: "Residente",
      local_permission_id: 0,
    });
    await insertar("profile_panel_rules", {
      installation_id: inst,
      profile_id: perfil,
      panel_id: panelA.id,
      output_mask: 1,
      card_reader_mask: 0,
      pin_reader_mask: 0,
      qr_reader_mask: 5,
      allow_rf: false,
      weekday_mask: 127,
      start_minute: 0,
      end_minute: 1439,
    });
  });

  afterAll(async () => {
    if (!admin) return;
    if (paneles.length) {
      for (const tabla of [
        "outputs",
        "profile_panel_rules",
        "control_button_panels",
        "panel_call_settings",
      ]) {
        const { error } = await admin
          .from(tabla)
          .delete()
          .in("panel_id", paneles);
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

  it("listChanges omite qr_codes a panel v8", async () => {
    const r = await pull(panelA, 0, 8);
    expect(tablas(r).has("qr_codes")).toBe(false);
    expect(tablas(r).has("qr_settings")).toBe(false);
    for (const tabla of ["qr_codes", "qr_settings"]) {
      const res = await getSnapshot(
        peticion(`snapshot?table=${tabla}`, panelA, 8),
      );
      expect(res.status).toBe(400);
    }
  });

  it("listChanges envía qr_codes a panel v9 en revisión", async () => {
    const r = await pull(panelA, 0, 9);
    const qr = de(r, "qr_codes") as Extract<ChangeItem, { op: "upsert" }>[];
    expect(qr).toHaveLength(1);
    expect(qr[0]).toMatchObject({ id: q1, op: "upsert" });
    expect(qr[0].data).toEqual({
      holder_id: h1,
      code: 912345678,
      label: "Visita",
      valid_from: "2026-11-26T08:00:00.000Z",
      valid_until: "2099-01-01T00:00:00.000Z",
      created_at: "2026-11-26T07:00:00.000Z",
      max_uses: 2,
    });
    // Un borrado viaja como delete.
    const q2 = await insertar("qr_codes", {
      installation_id: inst,
      holder_id: h1,
      code: 912345679,
      valid_from: "2026-11-26T08:00:00Z",
      valid_until: "2099-01-01T00:00:00Z",
    });
    const antes = await revisionInstalacion(inst);
    await admin
      .from("qr_codes")
      .update({ deleted_at: new Date().toISOString(), ...autor() })
      .eq("id", q2);
    expect(de(await pull(panelA, antes, 9), "qr_codes")).toMatchObject([
      { id: q2, op: "delete" },
    ]);
  });

  it("cambio de dígito emite qr_settings con la revisión", async () => {
    const antes = await revisionInstalacion(inst);
    const { error } = await admin.rpc("set_installation_qr_settings", {
      p_installation: inst,
      p_digit: 8,
      p_max_active: 50,
    });
    if (error) throw error;
    const { data } = await admin
      .from("installations")
      .select("qr_settings_revision")
      .eq("id", inst)
      .single();
    const r = await pull(panelA, antes, 9);
    expect(de(r, "qr_settings")).toEqual([
      {
        table: "qr_settings",
        op: "upsert",
        id: inst,
        revision: data!.qr_settings_revision,
        data: { digit: 8, max_active: 50 },
      },
    ]);
    expect(de(await pull(panelA, antes, 8), "qr_settings")).toEqual([]);
    const res = await getChanges(
      peticion(`changes?since=${antes}&limit=1`, panelA, 9),
    );
    expect(
      ((await res.json()) as PullResponse).changes.map((c) => c.table),
    ).toEqual(["qr_settings"]);
  });

  it("checksums de panel v9 incluyen qr_codes y qr_settings", async () => {
    const sumas = await checksums(panelA, 9);
    const qr = await snapshot(panelA, "qr_codes", 9);
    expect(qr.rows.map((f) => f.id)).toEqual([q1]);
    expect(sumas.tables.qr_codes).toBe(tableChecksum(qr.rows));
    const ajustes = await snapshot(panelA, "qr_settings", 9);
    expect(ajustes.rows).toEqual([
      { id: inst, data: { digit: 8, max_active: 50 } },
    ]);
    expect(sumas.tables.qr_settings).toBe(tableChecksum(ajustes.rows));
    const perm = await snapshot(panelA, "permissions", 9);
    expect(perm.rows[0].data.qr_reader_mask).toBe(5);
    expect(sumas.tables.permissions).toBe(tableChecksum(perm.rows));
    const v8 = await checksums(panelA, 8);
    expect(Object.keys(v8.tables)).not.toContain("qr_codes");
    expect(Object.keys(v8.tables)).not.toContain("qr_settings");
  });

  it("permissions de panel v8 sin qr_reader_mask", async () => {
    const v8 = await snapshot(panelA, "permissions", 8);
    expect(v8.rows[0].data).not.toHaveProperty("qr_reader_mask");
    expect(v8.rows[0].data).toHaveProperty("allow_call");
    const permisos = de(await pull(panelA, 0, 8), "permissions") as Extract<
      ChangeItem,
      { op: "upsert" }
    >[];
    expect(permisos[0].data).not.toHaveProperty("qr_reader_mask");
  });

  it("push de qr_settings es superseded", async () => {
    const res = await push(
      panelA,
      [
        {
          change_id: randomUUID().replaceAll("-", ""),
          table: "qr_settings",
          op: "upsert",
          id: randomUUID(),
          updated_at: new Date().toISOString(),
          data: { digit: 3, max_active: 10 },
        },
      ],
      9,
    );
    expect(res.status).toBe(200);
    const r = (await res.json()) as PushResponse;
    expect(r.results[0].status).toBe("superseded");
    expect(r.results[0].current).toEqual({
      data: { digit: 8, max_active: 50 },
    });
    const { data } = await admin
      .from("installations")
      .select("qr_digit, qr_max_active")
      .eq("id", inst)
      .single();
    expect(data).toEqual({ qr_digit: 8, qr_max_active: 50 });
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

    async function importar(
      panel: PanelPrueba,
      tables: unknown,
      schema?: number,
    ) {
      return importSnapshot(
        new Request(`${URL_BASE}/import-snapshot`, {
          method: "POST",
          headers: {
            ...cabeceras(panel, schema),
            "content-type": "application/json",
          },
          body: JSON.stringify({ tables }),
        }),
      );
    }

    const titular = (name: string) => ({
      id: randomUUID(),
      data: {
        kind: "persona",
        name,
        department: "",
        address: "",
        notes: "",
        pin: null,
      },
    });
    const qrDe = (holder_id: string, code: number) => ({
      id: randomUUID(),
      data: {
        holder_id,
        code,
        label: "Visita",
        valid_from: "2026-11-26T08:00:00.000Z",
        valid_until: "2099-01-01T00:00:00.000Z",
        created_at: "2026-11-26T07:00:00.000Z",
        max_uses: 1,
      },
    });

    it("importación de panel v9 con qr_codes", async () => {
      const i = await crearInstalacion("QR 2");
      const panel = await crearPanel(i, "staging");
      const luis = titular("Luis");
      const qr = qrDe(luis.id, 900000001);
      const res = await importar(
        panel,
        { ...vacias(), holders: [luis], qr_codes: [qr] },
        9,
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "active" });
      const { data } = await admin
        .from("qr_codes")
        .select("holder_id, code, max_uses")
        .eq("id", qr.id)
        .single();
      expect(data).toEqual({
        holder_id: luis.id,
        code: 900000001,
        max_uses: 1,
      });
    });

    it("importación de panel v8 sin qr_codes", async () => {
      const i = await crearInstalacion("QR 3");
      const panel = await crearPanel(i, "staging");
      const res = await importar(
        panel,
        { ...vacias(), holders: [titular("Mia")] },
        8,
      );
      expect(res.status).toBe(202);
      const { count } = await admin
        .from("qr_codes")
        .select("id", { count: "exact", head: true })
        .eq("installation_id", i);
      expect(count).toBe(0);
    });

    it("rechaza un snapshot con un QR de un titular que no está o con código de tarjeta", async () => {
      const i = await crearInstalacion("QR 4");
      const panel = await crearPanel(i, "staging");
      const sinTitular = await importar(
        panel,
        { ...vacias(), qr_codes: [qrDe(randomUUID(), 900000002)] },
        9,
      );
      expect(sinTitular.status).toBe(400);
      const ana = titular("Ana");
      const tarjeta = {
        id: randomUUID(),
        data: { card_code: 900000003, holder_id: ana.id, description: "" },
      };
      const choca = await importar(
        panel,
        {
          ...vacias(),
          holders: [ana],
          cards: [tarjeta],
          qr_codes: [qrDe(ana.id, 900000003)],
        },
        9,
      );
      expect(choca.status).toBe(400);
      expect((await choca.json()).code).toBe("invalid_snapshot");
    });

    it("ignora qr_codes de un panel que declara esquema 8", async () => {
      const i = await crearInstalacion("QR 5");
      const panel = await crearPanel(i, "staging");
      const eva = titular("Eva");
      const res = await importar(
        panel,
        { ...vacias(), holders: [eva], qr_codes: [qrDe(eva.id, 900000005)] },
        8,
      );
      expect(res.status).toBe(202);
      const { count } = await admin
        .from("qr_codes")
        .select("id", { count: "exact", head: true })
        .eq("installation_id", i);
      expect(count).toBe(0);
    });

    it("responde 400 en español si la base rechaza los QR (tope de vigentes)", async () => {
      const i = await crearInstalacion("QR 6");
      await admin.from("installations").update({ qr_max_active: 1 }).eq("id", i);
      const panel = await crearPanel(i, "staging");
      const leo = titular("Leo");
      const res = await importar(
        panel,
        {
          ...vacias(),
          holders: [leo],
          qr_codes: [qrDe(leo.id, 900000006), qrDe(leo.id, 900000007)],
        },
        9,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "invalid_snapshot",
        message: expect.stringContaining("máximo de QR vigentes"),
      });
    });
  });
});
