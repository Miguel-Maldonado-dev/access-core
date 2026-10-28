import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postAlerts } from "@/app/api/device/v1/alerts/route";
import { GET as getChanges, POST as postChanges } from "@/app/api/device/v1/changes/route";
import { GET as getChecksums } from "@/app/api/device/v1/checksums/route";
import { POST as postRegister } from "@/app/api/device/v1/register/route";
import { POST as postLogs } from "@/app/api/device/v1/logs/route";
import { LOG_BATCH } from "@/lib/device/contract";
import { CONFIRM_DELETIONS_WINDOW_S, confirmDeletionsAs } from "@/lib/panels/deletions";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

// Integración contra el Supabase LOCAL: subida de logs (POST /logs), alertas de borrado
// masivo (POST /alerts) y "Confirmar borrados". Cada corrida crea sus propios tenants,
// paneles y usuarios, y los borra al final.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const URL_BASE = "http://localhost/api/device/v1";

interface PanelPrueba {
  id: string;
  code: string;
  token: string;
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

/** Un log del panel en la forma del contrato (campos de más o de menos se sobrescriben). */
function log(id: number, extra: Record<string, unknown> = {}) {
  return {
    local_log_id: id,
    timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, id % 60)).toISOString(),
    allowed: true,
    source: 0,
    reason: 0,
    holder_id: null,
    holder_name: "Ana",
    holder_kind: "persona",
    credential_label: "Tarjeta 1001",
    control_id: null,
    code: 1001,
    device_id: 1,
    output_id: 0,
    ...extra,
  };
}

describe("logs, alertas y confirmación de borrados", () => {
  const corrida = base32(6).toLowerCase();
  const password = `Clave-${base32(8)}`;
  const correo = (n: string) => `n9-${n}-${corrida}@test.local`;

  let admin: SupabaseClient;
  const tenants: string[] = [];
  const paneles: string[] = [];
  const usuarios: string[] = [];

  let tenantA: string;
  let instA: string;
  let panelA: PanelPrueba;
  let panelA2: PanelPrueba;
  let panelS: PanelPrueba; // en staging
  let panelB: PanelPrueba; // otro tenant
  let clienteAdminA: SupabaseClient;
  let clienteTecnicoA: SupabaseClient;
  let clienteAdminB: SupabaseClient;

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

  async function filasDe(panel: PanelPrueba) {
    const { data, error } = await admin
      .from("access_logs")
      .select("*")
      .eq("panel_id", panel.id)
      .order("local_log_id");
    if (error) throw error;
    return data;
  }

  async function estadoPanel(panel: PanelPrueba) {
    const { data, error } = await admin
      .from("panels")
      .select("sync_blocked, confirm_deletions_until")
      .eq("id", panel.id)
      .single<{ sync_blocked: Record<string, unknown> | null; confirm_deletions_until: string | null }>();
    if (error) throw error;
    return data;
  }

  const enviar = (panel: PanelPrueba, logs: unknown[]) => postLogs(peticion("logs", panel, { logs }));
  const alerta = (panel: PanelPrueba, cuerpo: unknown) => postAlerts(peticion("alerts", panel, cuerpo));

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();

    const [adminA, tecnicoA, adminB] = await Promise.all([
      createLocalUser(admin, correo("admin-a"), password),
      createLocalUser(admin, correo("tecnico-a"), password),
      createLocalUser(admin, correo("admin-b"), password),
    ]);
    usuarios.push(adminA, tecnicoA, adminB);

    const { data: ts, error: e1 } = await admin
      .from("tenants")
      .insert([{ name: `Logs A ${corrida}` }, { name: `Logs B ${corrida}` }])
      .select("id, name");
    if (e1) throw e1;
    tenantA = ts.find((t) => t.name.startsWith("Logs A"))!.id;
    const tenantB = ts.find((t) => t.name.startsWith("Logs B"))!.id;
    tenants.push(tenantA, tenantB);

    const { error: e2 } = await admin.from("tenant_members").insert([
      { tenant_id: tenantA, user_id: adminA, role: "admin" },
      { tenant_id: tenantA, user_id: tecnicoA, role: "tecnico" },
      { tenant_id: tenantB, user_id: adminB, role: "admin" },
    ]);
    if (e2) throw e2;

    const { data: is, error: e3 } = await admin
      .from("installations")
      .insert([
        { tenant_id: tenantA, name: `Fracc A ${corrida}` },
        { tenant_id: tenantB, name: `Fracc B ${corrida}` },
      ])
      .select("id, tenant_id");
    if (e3) throw e3;
    instA = is.find((i) => i.tenant_id === tenantA)!.id;
    const instB = is.find((i) => i.tenant_id === tenantB)!.id;

    panelA = await crearPanel(instA);
    panelA2 = await crearPanel(instA);
    panelS = await crearPanel(instA, "staging");
    panelB = await crearPanel(instB);

    [clienteAdminA, clienteTecnicoA, clienteAdminB] = await Promise.all([
      signInLocal(correo("admin-a"), password),
      signInLocal(correo("tecnico-a"), password),
      signInLocal(correo("admin-b"), password),
    ]);
  });

  afterAll(async () => {
    if (!admin) return;
    // access_logs cae en cascada con paneles, instalaciones y tenants.
    if (paneles.length) {
      const { error } = await admin.from("panels").delete().in("id", paneles);
      if (error) throw error;
    }
    if (tenants.length) {
      const { error } = await admin.from("tenants").delete().in("id", tenants);
      if (error) throw error;
    }
    await Promise.all(usuarios.map((id) => admin.auth.admin.deleteUser(id)));
  });

  describe("POST /logs", () => {
    it("guarda el lote con el tenant, la instalación y el panel autenticados y responde {accepted, last_local_log_id}", async () => {
      const holder = randomUUID();
      const control = randomUUID();
      const res = await enviar(panelA, [
        log(1),
        log(3, { allowed: false, source: 1, reason: 5, holder_id: holder, control_id: control, code: 777, device_id: null, output_id: null }),
        log(2, { holder_name: null, holder_kind: null, credential_label: null, code: null }),
      ]);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ accepted: 3, last_local_log_id: 3 });

      const filas = await filasDe(panelA);
      expect(filas.map((f) => f.local_log_id)).toEqual([1, 2, 3]);
      for (const f of filas) {
        expect(f).toMatchObject({ tenant_id: tenantA, installation_id: instA, panel_id: panelA.id });
      }
      expect(filas[0]).toMatchObject({
        allowed: true,
        source: 0,
        reason: 0,
        holder_name: "Ana",
        holder_kind: "persona",
        credential_label: "Tarjeta 1001",
        code: 1001,
        device_id: 1,
        output_index: 0,
      });
      expect(new Date(filas[0].ts).toISOString()).toBe(log(1).timestamp);
      expect(filas[2]).toMatchObject({
        allowed: false,
        source: 1,
        reason: 5,
        holder_id: holder,
        control_id: control,
        code: 777,
        device_id: null,
        output_index: null,
      });
      expect(filas[1]).toMatchObject({ holder_name: null, holder_kind: null, credential_label: null, code: null });
    });

    it("enviar dos veces el mismo lote deja una sola fila por local_log_id y devuelve lo mismo", async () => {
      const lote = [log(10), log(11), log(12)];
      const r1 = await enviar(panelA, lote);
      const r2 = await enviar(panelA, lote);
      expect(await r1.json()).toEqual({ accepted: 3, last_local_log_id: 12 });
      expect(await r2.json()).toEqual({ accepted: 3, last_local_log_id: 12 });
      const ids = (await filasDe(panelA)).map((f) => f.local_log_id).filter((i) => i >= 10);
      expect(ids).toEqual([10, 11, 12]);
    });

    it("un local_log_id repetido dentro del mismo lote no falla", async () => {
      const res = await enviar(panelA, [log(20), log(20)]);
      expect(res.status).toBe(200);
      const ids = (await filasDe(panelA)).filter((f) => f.local_log_id === 20);
      expect(ids).toHaveLength(1);
    });

    it("last_local_log_id es el mayor recibido, venga en el orden que venga", async () => {
      const res = await enviar(panelA, [log(31), log(35), log(33)]);
      expect(await res.json()).toEqual({ accepted: 3, last_local_log_id: 35 });
    });

    it("un log de PIN con code=null se acepta", async () => {
      const res = await enviar(panelA, [log(40, { source: 3, reason: 8, allowed: false, code: null })]);
      expect(res.status).toBe(200);
      const f = (await filasDe(panelA)).find((x) => x.local_log_id === 40)!;
      expect(f).toMatchObject({ source: 3, code: null });
    });

    it("un log de PIN con code distinto de null se guarda con code=null (nunca dígitos de PIN)", async () => {
      const res = await enviar(panelA, [log(41, { source: 3, reason: 0, code: 123456 })]);
      expect(res.status).toBe(200);
      const f = (await filasDe(panelA)).find((x) => x.local_log_id === 41)!;
      expect(f.code).toBeNull();
    });

    it("los local_log_id son por panel: otro panel con el mismo id guarda su propia fila", async () => {
      await enviar(panelA, [log(50, { holder_name: "De A" })]);
      await enviar(panelA2, [log(50, { holder_name: "De A2" })]);
      await enviar(panelA2, [log(50, { holder_name: "Reintento A2" })]);
      expect((await filasDe(panelA)).find((f) => f.local_log_id === 50)!.holder_name).toBe("De A");
      const delOtro = (await filasDe(panelA2)).filter((f) => f.local_log_id === 50);
      expect(delOtro).toHaveLength(1);
      expect(delOtro[0].holder_name).toBe("De A2");
    });

    it("el tenant y la instalación salen del panel autenticado, no del cuerpo", async () => {
      const res = await enviar(panelB, [
        { ...log(60), tenant_id: tenantA, installation_id: instA, panel_id: panelA.id },
      ]);
      expect(res.status).toBe(200);
      expect(await filasDe(panelB)).toHaveLength(1);
      expect((await filasDe(panelA)).some((f) => f.local_log_id === 60)).toBe(false);
    });

    it("acepta un lote de LOG_BATCH logs y rechaza uno de LOG_BATCH + 1 sin guardar nada", async () => {
      const ok = Array.from({ length: LOG_BATCH }, (_, i) => log(1000 + i));
      expect((await enviar(panelA, ok)).status).toBe(200);
      const largo = Array.from({ length: LOG_BATCH + 1 }, (_, i) => log(5000 + i));
      expect((await enviar(panelA, largo)).status).toBe(400);
      expect((await filasDe(panelA)).some((f) => f.local_log_id === 5000)).toBe(false);
    });

    it("rechaza con 400 un lote vacío, tipos o rangos inválidos y fechas que no son ISO-8601", async () => {
      const malos: unknown[][] = [
        [],
        [log(70, { timestamp: "ayer" })],
        [log(70, { timestamp: "2026-10-01" })],
        [log(70, { allowed: 1 })],
        [log(70, { source: -1 })],
        [log(70, { source: 1.5 })],
        [log(70, { reason: 999 })],
        [log(70, { local_log_id: 0 })],
        [log(70, { holder_id: "no-es-uuid" })],
        [log(70, { holder_kind: "robot" })],
        [log(70, { code: 4294967296 })],
        [log(70, { output_id: 4 })],
        [log(70, { holder_name: 5 })],
        [{ ...log(70), allowed: undefined }],
      ];
      for (const lote of malos) {
        const res = await enviar(panelA, lote);
        expect(res.status, JSON.stringify(lote)).toBe(400);
        expect((await res.json()).code).toBe("invalid_body");
      }
      expect((await filasDe(panelA)).some((f) => f.local_log_id === 70)).toBe(false);
    });

    it("un texto con el carácter NUL responde 400 con un mensaje claro, no 500", async () => {
      const res = await enviar(panelA, [log(80, { holder_name: "Ana\u0000" })]);
      expect(res.status).toBe(400);
      const cuerpo = await res.json();
      expect(cuerpo.code).toBe("invalid_body");
      expect(cuerpo.message).toContain("holder_name");
      expect(cuerpo.message).toMatch(/NUL|\\u0000/);
      const res2 = await enviar(panelA, [log(80, { credential_label: "\u0000" })]);
      expect(res2.status).toBe(400);
    });

    it("sin credencial responde 401 y con un panel que no está activo responde 409", async () => {
      expect((await postLogs(peticion("logs", undefined, { logs: [log(1)] }))).status).toBe(401);
      const res = await enviar(panelS, [log(1)]);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("not_active");
    });
  });

  describe("textos con NUL en POST /changes", () => {
    it("un push con \\u0000 en un texto responde 400, no 500, y no aplica nada", async () => {
      const cambio = {
        change_id: randomBytes(16).toString("hex"),
        table: "holders",
        op: "upsert",
        id: randomUUID(),
        updated_at: new Date(Date.now() + 1000).toISOString(),
        data: { kind: "persona", name: "Ana\u0000", department: "", address: "", notes: "", pin: null },
      };
      const res = await postChanges(peticion("changes", panelA, { changes: [cambio] }));
      expect(res.status).toBe(400);
      const cuerpo = await res.json();
      expect(cuerpo.code).toBe("invalid_body");
      expect(cuerpo.message).toMatch(/NUL|\\u0000/);

      const otro = { ...cambio, data: { ...cambio.data, name: "Ana", notes: "x\u0000y" } };
      expect((await postChanges(peticion("changes", panelA, { changes: [otro] }))).status).toBe(400);
      const sinNul = { ...cambio, change_id: "id\u0000", data: { ...cambio.data, name: "Ana" } };
      expect((await postChanges(peticion("changes", panelA, { changes: [sinNul] }))).status).toBe(400);
    });
  });

  describe("software_version con NUL en POST /register", () => {
    it("responde 400, no 500", async () => {
      const res = await postRegister(
        peticion("register", undefined, {
          panel_code: `PNL-${base32(4)}-${base32(4)}`,
          claim_code_hash: sha256("a"),
          panel_secret_hash: sha256("b"),
          software_version: "1.0\u0000",
          schema_version: 6,
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /alerts", () => {
    it("guarda sync_blocked con tipo, tabla, cifras y hora, y responde 204", async () => {
      const antes = Date.now();
      const res = await alerta(panelA, { type: "mass_delete_blocked", table: "holders", would_delete: 30, total: 100 });
      expect(res.status).toBe(204);
      const { sync_blocked } = await estadoPanel(panelA);
      expect(sync_blocked).toMatchObject({ type: "mass_delete_blocked", table: "holders", would_delete: 30, total: 100 });
      const at = Date.parse(String(sync_blocked!.at));
      expect(at).toBeGreaterThanOrEqual(antes - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("rechaza con 400 tipos, tablas y cifras inválidas sin tocar sync_blocked", async () => {
      const antes = (await estadoPanel(panelA)).sync_blocked;
      for (const cuerpo of [
        { type: "otro", table: "holders", would_delete: 1, total: 2 },
        { type: "mass_delete_blocked", table: "permissions", would_delete: 1, total: 2 },
        { type: "mass_delete_blocked", table: "cards", would_delete: -1, total: 2 },
        { type: "mass_delete_blocked", table: "cards", would_delete: 1.5, total: 2 },
        { type: "mass_delete_blocked", table: "cards", would_delete: 1 },
      ]) {
        const res = await alerta(panelA, cuerpo);
        expect(res.status, JSON.stringify(cuerpo)).toBe(400);
      }
      expect((await estadoPanel(panelA)).sync_blocked).toEqual(antes);
    });

    it("sin credencial responde 401 y con un panel que no está activo, 409", async () => {
      const cuerpo = { type: "mass_delete_blocked", table: "cards", would_delete: 1, total: 2 };
      expect((await postAlerts(peticion("alerts", undefined, cuerpo))).status).toBe(401);
      expect((await alerta(panelS, cuerpo)).status).toBe(409);
    });
  });

  describe("confirmDeletionsAs", () => {
    const bloquear = (panel: PanelPrueba) =>
      alerta(panel, { type: "mass_delete_blocked", table: "cards", would_delete: 20, total: 50 });
    const confirmaciones = async (panel: PanelPrueba) => {
      const [c, k] = await Promise.all([
        getChanges(peticion("changes?since=0&limit=1", panel)),
        getChecksums(peticion("checksums", panel)),
      ]);
      return [(await c.json()).confirm_deletions, (await k.json()).confirm_deletions];
    };

    it("un admin pone la vigencia de una hora, limpia sync_blocked y el pull y /checksums traen confirm_deletions:true", async () => {
      await bloquear(panelA2);
      expect(await confirmaciones(panelA2)).toEqual([false, false]);

      const antes = Date.now();
      await confirmDeletionsAs(clienteAdminA, panelA2.id);
      const estado = await estadoPanel(panelA2);
      expect(estado.sync_blocked).toBeNull();
      const hasta = Date.parse(estado.confirm_deletions_until!);
      expect(hasta).toBeGreaterThanOrEqual(antes + CONFIRM_DELETIONS_WINDOW_S * 1000 - 2000);
      expect(hasta).toBeLessThanOrEqual(Date.now() + CONFIRM_DELETIONS_WINDOW_S * 1000 + 2000);
      expect(CONFIRM_DELETIONS_WINDOW_S).toBe(3600);
      expect(await confirmaciones(panelA2)).toEqual([true, true]);
    });

    it("la confirmación caduca sola: con confirm_deletions_until en el pasado trae false", async () => {
      const { error } = await admin
        .from("panels")
        .update({ confirm_deletions_until: new Date(Date.now() - 1000).toISOString() })
        .eq("id", panelA2.id);
      if (error) throw error;
      expect(await confirmaciones(panelA2)).toEqual([false, false]);
    });

    it("un tecnico no puede confirmar borrados (403) y no cambia nada", async () => {
      await bloquear(panelA);
      await expect(confirmDeletionsAs(clienteTecnicoA, panelA.id)).rejects.toMatchObject({ status: 403 });
      const estado = await estadoPanel(panelA);
      expect(estado.sync_blocked).not.toBeNull();
    });

    it("un admin de otro tenant ve 404 y no cambia nada", async () => {
      await expect(confirmDeletionsAs(clienteAdminB, panelA.id)).rejects.toMatchObject({ status: 404 });
      expect((await estadoPanel(panelA)).confirm_deletions_until).toBeNull();
    });

    it("un id que no es UUID o no existe da 404", async () => {
      await expect(confirmDeletionsAs(clienteAdminA, "no-es-uuid")).rejects.toMatchObject({ status: 404 });
      await expect(confirmDeletionsAs(clienteAdminA, randomUUID())).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("access_logs para los miembros", () => {
    it("un miembro lee los logs de su tenant y no los de otro; no puede escribir", async () => {
      const { data: propios, error } = await clienteTecnicoA.from("access_logs").select("panel_id");
      if (error) throw error;
      expect(propios!.length).toBeGreaterThan(0);
      expect(propios!.every((f) => f.panel_id !== panelB.id)).toBe(true);
      const { data: deB } = await clienteAdminB.from("access_logs").select("panel_id");
      expect(deB!.every((f) => f.panel_id === panelB.id)).toBe(true);

      const { error: errorEscritura } = await clienteAdminA.from("access_logs").insert({
        tenant_id: tenantA,
        installation_id: instA,
        panel_id: panelA.id,
        local_log_id: 99999,
        ts: new Date().toISOString(),
        allowed: true,
        source: 0,
        reason: 0,
      });
      expect(errorEscritura).not.toBeNull();
    });
  });
});
