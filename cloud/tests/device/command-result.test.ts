import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postCommandResult } from "@/app/api/device/v1/command-result/route";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Integración contra el Supabase LOCAL: resultado de las órdenes de la nube
// (POST /api/device/v1/command-result). Cada corrida crea su tenant y sus paneles y los
// borra al final (las órdenes caen en cascada).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");

interface PanelPrueba {
  id: string;
  code: string;
  token: string;
}

function peticion(panel: PanelPrueba | undefined, cuerpo: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (panel) headers.authorization = `Device ${panel.code}.${panel.token}`;
  return new Request("http://localhost/api/device/v1/command-result", {
    method: "POST",
    headers,
    body: JSON.stringify(cuerpo),
  });
}

describe("POST /command-result", () => {
  let admin: SupabaseClient;
  let tenantId: string;
  let installationId: string;
  let panelA: PanelPrueba;
  let panelA2: PanelPrueba;
  let panelS: PanelPrueba; // en staging
  let holderId: string;
  const paneles: string[] = [];
  let salida = 0;

  async function crearPanel(status = "active"): Promise<PanelPrueba> {
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

  /**
   * Orden `pending` del panel; `venceEnMs` negativo la deja ya caducada. `remota` crea una
   * `remote_open` (con su titular) en lugar de una `test_output`.
   */
  async function crearOrden(panel: PanelPrueba, venceEnMs = 10_000, remota = false, escucha = false): Promise<string> {
    const { data, error } = await admin
      .from("panel_commands")
      .insert({
        tenant_id: tenantId,
        installation_id: installationId,
        panel_id: panel.id,
        kind: escucha ? "listen_rf" : remota ? "remote_open" : "test_output",
        holder_id: remota ? holderId : null,
        // Cada orden en una salida distinta del ciclo 0..3 para no chocar con otra pendiente.
        output_index: escucha ? null : salida++ % 4,
        requested_by: "tecnico@test.local",
        expires_at: new Date(Date.now() + venceEnMs).toISOString(),
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }

  async function orden(id: string) {
    const { data, error } = await admin
      .from("panel_commands")
      .select("status, detail, reason, rf_code, finished_at")
      .eq("id", id)
      .single<{ status: string; detail: string | null; reason: number | null; rf_code: number | null; finished_at: string | null }>();
    if (error) throw error;
    return data;
  }

  /** Deja la orden fuera del camino de las siguientes (una sola pendiente por salida). */
  async function cerrar(id: string) {
    const { error } = await admin
      .from("panel_commands")
      .update({ status: "expired", finished_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending");
    if (error) throw error;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();
    const sufijo = base32(6);
    const t = await admin.from("tenants").insert({ name: `T-cmd-${sufijo}` }).select("id").single();
    if (t.error) throw t.error;
    tenantId = t.data.id;
    const i = await admin
      .from("installations")
      .insert({ tenant_id: tenantId, name: `I-cmd-${sufijo}` })
      .select("id")
      .single();
    if (i.error) throw i.error;
    installationId = i.data.id;
    panelA = await crearPanel();
    panelA2 = await crearPanel();
    panelS = await crearPanel("staging");
    const h = await admin
      .from("holders")
      .insert({ installation_id: installationId, kind: "persona", name: "Ana", updated_by: "prueba", origin: "cloud" })
      .select("id")
      .single<{ id: string }>();
    if (h.error) throw h.error;
    holderId = h.data.id;
  });

  afterAll(async () => {
    if (!admin) return;
    if (paneles.length) await admin.from("panels").delete().in("id", paneles);
    if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
  });

  it("un resultado ok marca la orden como ok con su hora y responde 204", async () => {
    const id = await crearOrden(panelA);
    const antes = Date.now();
    const res = await postCommandResult(peticion(panelA, { command_id: id, ok: true, detail: null }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const o = await orden(id);
    expect(o).toMatchObject({ status: "ok", detail: null, reason: null });
    expect(Date.parse(o.finished_at!)).toBeGreaterThanOrEqual(antes - 1000);
  });

  it("un resultado con ok=false marca la orden como error con el detalle del panel", async () => {
    const id = await crearOrden(panelA);
    const res = await postCommandResult(
      peticion(panelA, { command_id: id, ok: false, detail: "El daemon no responde" }),
    );
    expect(res.status).toBe(204);
    expect(await orden(id)).toMatchObject({ status: "error", detail: "El daemon no responde" });
  });

  it("detail es opcional", async () => {
    const id = await crearOrden(panelA);
    expect((await postCommandResult(peticion(panelA, { command_id: id, ok: true }))).status).toBe(204);
    expect(await orden(id)).toMatchObject({ status: "ok", detail: null });
  });

  it("el resultado de una apertura remota guarda su motivo (reason)", async () => {
    const negada = await crearOrden(panelA, 10_000, true);
    const res = await postCommandResult(
      peticion(panelA, { command_id: negada, ok: false, detail: "Sin permiso de apertura remota", reason: 3 }),
    );
    expect(res.status).toBe(204);
    expect(await orden(negada)).toMatchObject({ status: "error", detail: "Sin permiso de apertura remota", reason: 3 });

    const abierta = await crearOrden(panelA, 10_000, true);
    const ok = await postCommandResult(
      peticion(panelA, { command_id: abierta, ok: true, detail: "Salida abierta", reason: 0 }),
    );
    expect(ok.status).toBe(204);
    expect(await orden(abierta)).toMatchObject({ status: "ok", detail: "Salida abierta", reason: 0 });
  });

  it("un resultado tardío de una apertura remota no guarda su motivo", async () => {
    const id = await crearOrden(panelA, -1000, true);
    const res = await postCommandResult(peticion(panelA, { command_id: id, ok: true, detail: null, reason: 0 }));
    expect(res.status).toBe(204);
    expect(await orden(id)).toMatchObject({ status: "expired", detail: null, reason: null });
  });

  it("un listen_rf con resultado 10 s después de expires_at queda ok con su rf_code", async () => {
    const id = await crearOrden(panelA2, -10_000, false, true);
    const res = await postCommandResult(peticion(panelA2, { command_id: id, ok: true, detail: null, rf_code: 4294967295 }));
    expect(res.status).toBe(204);
    expect(await orden(id)).toMatchObject({ status: "ok", rf_code: 4294967295 });
  });

  it("un listen_rf con resultado 16 s después de expires_at queda expired, sin rf_code", async () => {
    const id = await crearOrden(panelA2, -16_000, false, true);
    await postCommandResult(peticion(panelA2, { command_id: id, ok: true, detail: null, rf_code: 123 }));
    expect(await orden(id)).toMatchObject({ status: "expired", rf_code: null });
  });

  it("un test_output pasado de expires_at sigue venciendo (sin el margen de listen_rf)", async () => {
    const id = await crearOrden(panelA, -10_000);
    await postCommandResult(peticion(panelA, { command_id: id, ok: true, detail: null }));
    expect(await orden(id)).toMatchObject({ status: "expired" });
  });

  it("el resultado de otro panel da 404 y no toca la orden", async () => {
    const id = await crearOrden(panelA);
    const res = await postCommandResult(peticion(panelA2, { command_id: id, ok: true, detail: null }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "not_found", message: "Orden no encontrada" });
    expect(await orden(id)).toMatchObject({ status: "pending", finished_at: null });
    await cerrar(id);
  });

  it("una orden que no existe da 404", async () => {
    const res = await postCommandResult(peticion(panelA, { command_id: randomUUID(), ok: true, detail: null }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("un resultado tardío deja la orden en expired, sin el estado ni el detalle del panel", async () => {
    const id = await crearOrden(panelA, -1000);
    const res = await postCommandResult(peticion(panelA, { command_id: id, ok: false, detail: "Falló el UART" }));
    expect(res.status).toBe(204);
    const o = await orden(id);
    expect(o).toMatchObject({ status: "expired", detail: null });
    expect(o.finished_at).not.toBeNull();
  });

  it("un resultado repetido de una orden ya terminada no la cambia", async () => {
    const id = await crearOrden(panelA);
    await postCommandResult(peticion(panelA, { command_id: id, ok: true, detail: null }));
    const primero = await orden(id);
    const res = await postCommandResult(peticion(panelA, { command_id: id, ok: false, detail: "otro" }));
    expect(res.status).toBe(204);
    expect(await orden(id)).toEqual(primero);
  });

  it("sin credencial responde 401 y con un panel que no está activo, 409", async () => {
    const id = await crearOrden(panelA);
    expect((await postCommandResult(peticion(undefined, { command_id: id, ok: true, detail: null }))).status).toBe(401);
    expect((await postCommandResult(peticion(panelS, { command_id: id, ok: true, detail: null }))).status).toBe(409);
    expect(await orden(id)).toMatchObject({ status: "pending" });
    await cerrar(id);
  });

  it("un cuerpo inválido responde 400 invalid_body", async () => {
    const id = await crearOrden(panelA);
    for (const cuerpo of [
      { command_id: "no-es-uuid", ok: true, detail: null },
      { command_id: id.toUpperCase(), ok: true, detail: null },
      { command_id: id, ok: "sí", detail: null },
      { command_id: id, detail: null },
      { command_id: id, ok: true, detail: "x".repeat(201) },
      { command_id: id, ok: true, detail: null, extra: 1 },
      { command_id: id, ok: true, detail: null, reason: 256 },
      { command_id: id, ok: true, detail: null, reason: -1 },
      { command_id: id, ok: true, detail: null, reason: 1.5 },
      { command_id: id, ok: true, detail: null, reason: "3" },
      { command_id: id, ok: true, detail: null, rf_code: 4294967296 },
      { command_id: id, ok: true, detail: null, rf_code: -1 },
      { command_id: id, ok: true, detail: null, rf_code: 1.5 },
    ]) {
      const res = await postCommandResult(peticion(panelA, cuerpo));
      expect(res.status, JSON.stringify(cuerpo)).toBe(400);
      expect((await res.json()).code).toBe("invalid_body");
    }
    expect(await orden(id)).toMatchObject({ status: "pending" });
    await cerrar(id);
  });
});
