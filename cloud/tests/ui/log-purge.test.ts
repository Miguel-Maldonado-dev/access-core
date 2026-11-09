import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { purgeInstallationLogsAs } from "@/lib/log-purge";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

// "Borrar logs" contra el Supabase LOCAL. Sin broker: `fetch` simulado solo para EMQX.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const CLAVE = "Clave-de-prueba-123";
const EMQX = "http://emqx.test:18083";

async function fallo(promesa: Promise<unknown>): Promise<HttpError> {
  try {
    await promesa;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("Se esperaba un HttpError y salió bien.");
}

describe("purgeInstallationLogsAs", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `lp-${n}-${sufijo}@test.local`;
  const nombre = `Fracc Purga ${sufijo}`;
  const usuarios: string[] = [];
  const entornoOriginal = { ...process.env };
  let tenant: string;
  let inst: string;
  let adminId: string;
  let adminC: SupabaseClient;
  let tecnicoC: SupabaseClient;
  const panel: Record<"p1" | "p2" | "p3", { id: string; code: string }> = {} as never;
  let publicaciones: { topic: string; payload: Record<string, unknown> }[] = [];
  let rechazar = new Set<string>();

  async function sembrarLogs(ids: number[]) {
    const { error } = await admin.from("access_logs").insert(
      ids.map((n) => ({
        tenant_id: tenant,
        installation_id: inst,
        panel_id: panel.p1.id,
        local_log_id: n,
        ts: new Date().toISOString(),
        source: 1,
        reason: 0,
        allowed: true,
      })),
    );
    if (error) throw error;
  }
  const contar = async (tabla: "access_logs" | "log_purges") => {
    const { count, error } = await admin.from(tabla).select("*", { count: "exact", head: true }).eq("installation_id", inst);
    if (error) throw error;
    return count ?? 0;
  };

  async function crearPanel(status: string) {
    const code = `PNL-${base32(4)}-${base32(4)}`;
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: code,
        panel_secret_hash: sha256(randomBytes(8).toString("hex")),
        device_token_hash: sha256(randomBytes(32).toString("base64url")),
        installation_id: inst,
        status,
        online: true,
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return { id: data.id, code };
  }

  beforeAll(async () => {
    requireLocalSupabase();
    const { data: t, error: e1 } = await admin.from("tenants").insert({ name: `LP ${sufijo}` }).select("id").single();
    if (e1) throw e1;
    tenant = t.id;
    const ids = await Promise.all([createLocalUser(admin, correo("admin"), CLAVE), createLocalUser(admin, correo("tec"), CLAVE)]);
    usuarios.push(...ids);
    adminId = ids[0];
    const { error: e2 } = await admin.from("tenant_members").insert([
      { tenant_id: tenant, user_id: ids[0], role: "admin" },
      { tenant_id: tenant, user_id: ids[1], role: "tecnico" },
    ]);
    if (e2) throw e2;
    const { data: i, error: e3 } = await admin.from("installations").insert({ tenant_id: tenant, name: nombre }).select("id").single();
    if (e3) throw e3;
    inst = i.id;
    panel.p1 = await crearPanel("active");
    panel.p2 = await crearPanel("active");
    panel.p3 = await crearPanel("staging");
    [adminC, tecnicoC] = await Promise.all([signInLocal(correo("admin"), CLAVE), signInLocal(correo("tec"), CLAVE)]);
  });

  beforeEach(() => {
    publicaciones = [];
    rechazar = new Set();
    process.env.EMQX_API_URL = EMQX;
    process.env.EMQX_API_KEY = "llave";
    process.env.EMQX_API_SECRET = "secreto-api";
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith(EMQX)) return real(url, init);
      const cuerpo = JSON.parse(String(init?.body)) as { topic: string; payload: string };
      if (rechazar.has(cuerpo.topic.split("/")[1])) return new Response("no", { status: 503 });
      publicaciones.push({ topic: cuerpo.topic, payload: JSON.parse(cuerpo.payload) });
      return Response.json({ id: "x" });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...entornoOriginal };
  });

  afterAll(async () => {
    await admin.from("panels").delete().eq("installation_id", inst);
    await admin.from("tenants").delete().eq("id", tenant);
    for (const u of usuarios) await admin.auth.admin.deleteUser(u);
  });

  it("un técnico recibe 403, no publica y deja logs y bitácora intactos", async () => {
    await sembrarLogs([901, 902]);
    const [logsAntes, purgasAntes] = [await contar("access_logs"), await contar("log_purges")];
    expect((await fallo(purgeInstallationLogsAs(tecnicoC, tenant, inst, nombre))).status).toBe(403);
    expect(publicaciones).toEqual([]);
    expect(await contar("access_logs")).toBe(logsAntes);
    expect(await contar("log_purges")).toBe(purgasAntes);
    await admin.from("access_logs").delete().eq("installation_id", inst);
  });

  it("un nombre distinto da 400 (distingue mayúsculas) y no publica", async () => {
    for (const mal of ["", "otro", nombre.toUpperCase()]) {
      expect(await fallo(purgeInstallationLogsAs(adminC, tenant, inst, mal))).toMatchObject({
        status: 400,
        message: "El nombre no coincide con la instalación.",
      });
    }
    expect(publicaciones).toEqual([]);
  });

  it("el admin borra, deja la bitácora y publica sync a los paneles activos", async () => {
    await admin.from("access_logs").delete().eq("installation_id", inst);
    await sembrarLogs([1, 2]);
    expect(await contar("access_logs")).toBe(2);
    const purgasAntes = await contar("log_purges");

    const r = await purgeInstallationLogsAs(adminC, tenant, inst, `  ${nombre} `);
    expect(r).toEqual({ deleted: 2 });
    expect(await contar("access_logs")).toBe(0);
    expect(await contar("log_purges")).toBe(purgasAntes + 1);
    const { data: bitacora } = await admin
      .from("log_purges")
      .select("*")
      .eq("installation_id", inst)
      .order("purged_at", { ascending: false })
      .limit(1);
    expect(bitacora![0]).toMatchObject({ purged_by: adminId, purged_by_label: correo("admin"), deleted_count: 2 });
    expect(publicaciones.map((p) => p.topic).sort()).toEqual([`acc/${panel.p1.code}/cmd`, `acc/${panel.p2.code}/cmd`].sort());
    for (const p of publicaciones) expect(p.payload).toEqual({ type: "sync" });
  });

  it("un publish fallido no rompe el borrado", async () => {
    await admin.from("access_logs").delete().eq("installation_id", inst);
    const purgasAntes = await contar("log_purges");
    rechazar.add(panel.p1.code);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await purgeInstallationLogsAs(adminC, tenant, inst, nombre);
    expect(r.deleted).toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    expect(publicaciones.map((p) => p.topic)).toEqual([`acc/${panel.p2.code}/cmd`]);
    expect(await contar("log_purges")).toBe(purgasAntes + 1);
  });
});
