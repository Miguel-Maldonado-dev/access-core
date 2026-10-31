import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { commandStatusAs, logsUploadStatusAs, requestLogsUploadAs, testOutputAs } from "@/lib/panel-commands";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

// Órdenes a los paneles desde la interfaz ("Actualizar logs" y "Probar") contra el
// Supabase LOCAL. Sin broker: `fetch` simulado solo para la API de EMQX.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const CLAVE = "Clave-de-prueba-123";
const AUTOR = { updated_by: "prueba", origin: "cloud" };
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

interface Publicacion {
  topic: string;
  payload: Record<string, unknown>;
}

describe("órdenes a los paneles (panel-commands)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `t9-${n}-${sufijo}@test.local`;
  const usuarios: string[] = [];
  const tenants: string[] = [];
  const paneles: string[] = [];
  const entornoOriginal = { ...process.env };

  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instB: string;
  let tecnicoA: SupabaseClient;
  let adminA: SupabaseClient;
  let adminB: SupabaseClient;
  let tecnicoAId: string;

  // Instalación A: P1 y P4 activos en línea, P2 activo sin conexión, P3 en staging en línea.
  const P: Record<"p1" | "p2" | "p3" | "p4" | "pb", { id: string; code: string }> = {} as never;
  // Salidas: s1 en P1 (índice 1), s2 en P2, s3 en P3, sBorrada en P1 (borrada), sB en el tenant B.
  const S: Record<"s1" | "s2" | "s3" | "sBorrada" | "sB", string> = {} as never;

  let publicaciones: Publicacion[] = [];
  /** Códigos de panel cuya publicación EMQX rechaza (HTTP 503). */
  let rechazar = new Set<string>();

  async function crearPanel(installationId: string, status: string, online: boolean) {
    const code = `PNL-${base32(4)}-${base32(4)}`;
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: code,
        panel_secret_hash: sha256(randomBytes(8).toString("hex")),
        device_token_hash: sha256(randomBytes(32).toString("base64url")),
        installation_id: installationId,
        status,
        online,
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    paneles.push(data.id);
    return { id: data.id, code };
  }

  async function crearSalida(installationId: string, panelId: string, outputIndex: number, borrada = false) {
    const { data, error } = await admin
      .from("outputs")
      .insert({
        installation_id: installationId,
        panel_id: panelId,
        output_index: outputIndex,
        alias: "",
        duration_ms: 3000,
        reader_mask: 1,
        enabled: true,
        deleted_at: borrada ? new Date().toISOString() : null,
        ...AUTOR,
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }

  async function ordenesDe(panelId: string) {
    const { data, error } = await admin
      .from("panel_commands")
      .select("*")
      .eq("panel_id", panelId)
      .order("created_at");
    if (error) throw error;
    return data;
  }

  async function cambiarInstalacion(id: string, cambios: Record<string, unknown>) {
    const { error } = await admin.from("installations").update(cambios).eq("id", id);
    if (error) throw error;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    const { data: ts, error: e1 } = await admin
      .from("tenants")
      .insert([{ name: `T9 A ${sufijo}` }, { name: `T9 B ${sufijo}` }])
      .select("id, name");
    if (e1) throw e1;
    tenantA = ts.find((t) => t.name.startsWith("T9 A"))!.id;
    tenantB = ts.find((t) => t.name.startsWith("T9 B"))!.id;
    tenants.push(tenantA, tenantB);

    const ids = await Promise.all([
      createLocalUser(admin, correo("tecnico-a"), CLAVE),
      createLocalUser(admin, correo("admin-a"), CLAVE),
      createLocalUser(admin, correo("admin-b"), CLAVE),
    ]);
    usuarios.push(...ids);
    tecnicoAId = ids[0];
    const { error: e2 } = await admin.from("tenant_members").insert([
      { tenant_id: tenantA, user_id: ids[0], role: "tecnico" },
      { tenant_id: tenantA, user_id: ids[1], role: "admin" },
      { tenant_id: tenantB, user_id: ids[2], role: "admin" },
    ]);
    if (e2) throw e2;

    const { data: is, error: e3 } = await admin
      .from("installations")
      .insert([
        { tenant_id: tenantA, name: `Fracc A ${sufijo}` },
        { tenant_id: tenantB, name: `Fracc B ${sufijo}` },
      ])
      .select("id, tenant_id");
    if (e3) throw e3;
    instA = is.find((i) => i.tenant_id === tenantA)!.id;
    instB = is.find((i) => i.tenant_id === tenantB)!.id;

    P.p1 = await crearPanel(instA, "active", true);
    P.p2 = await crearPanel(instA, "active", false);
    P.p3 = await crearPanel(instA, "staging", true);
    P.p4 = await crearPanel(instA, "active", true);
    P.pb = await crearPanel(instB, "active", true);

    S.s1 = await crearSalida(instA, P.p1.id, 1);
    S.s2 = await crearSalida(instA, P.p2.id, 2);
    S.s3 = await crearSalida(instA, P.p3.id, 0);
    S.sBorrada = await crearSalida(instA, P.p1.id, 3, true);
    S.sB = await crearSalida(instB, P.pb.id, 0);

    [tecnicoA, adminA, adminB] = await Promise.all([
      signInLocal(correo("tecnico-a"), CLAVE),
      signInLocal(correo("admin-a"), CLAVE),
      signInLocal(correo("admin-b"), CLAVE),
    ]);
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
      const codigo = cuerpo.topic.split("/")[1];
      if (rechazar.has(codigo)) return new Response("no", { status: 503 });
      publicaciones.push({ topic: cuerpo.topic, payload: JSON.parse(cuerpo.payload) });
      return Response.json({ id: "x" });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...entornoOriginal };
  });

  afterAll(async () => {
    const borrado = async (que: string, consulta: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await consulta;
      if (error) throw new Error(`No se pudo limpiar ${que}: ${error.message}`);
    };
    // panel_commands cae en cascada con los paneles.
    await borrado("outputs", admin.from("outputs").delete().in("panel_id", paneles));
    await borrado("paneles", admin.from("panels").delete().in("id", paneles));
    await borrado("tenants", admin.from("tenants").delete().in("id", tenants));
    for (const u of usuarios) await admin.auth.admin.deleteUser(u);
  });

  describe("requestLogsUploadAs", () => {
    beforeEach(() => cambiarInstalacion(instA, { logs_requested_at: null }));

    it("publica upload_logs solo a los paneles activos en línea y devuelve los activos con su estado", async () => {
      const antes = Date.now();
      const r = await requestLogsUploadAs(tecnicoA, tenantA, instA);
      expect(publicaciones.map((p) => p.topic).sort()).toEqual([`acc/${P.p1.code}/cmd`, `acc/${P.p4.code}/cmd`].sort());
      for (const p of publicaciones) expect(p.payload).toEqual({ type: "upload_logs" });

      expect(r.panels.map((p) => p.id).sort()).toEqual([P.p1.id, P.p2.id, P.p4.id].sort());
      expect(r.panels.find((p) => p.id === P.p2.id)).toEqual({ id: P.p2.id, panel_code: P.p2.code, online: false });
      expect(r.panels.find((p) => p.id === P.p1.id)).toEqual({ id: P.p1.id, panel_code: P.p1.code, online: true });

      expect(r.requestedAt).toMatch(/Z$/);
      expect(Date.parse(r.requestedAt)).toBeGreaterThanOrEqual(antes - 1000);
      const { data } = await admin.from("installations").select("logs_requested_at").eq("id", instA).single();
      expect(Date.parse(data!.logs_requested_at)).toBe(Date.parse(r.requestedAt));
    });

    it("una segunda petición antes de 10 s da 429 y no publica", async () => {
      await requestLogsUploadAs(tecnicoA, tenantA, instA);
      publicaciones = [];
      const e = await fallo(requestLogsUploadAs(adminA, tenantA, instA));
      expect(e.status).toBe(429);
      expect(e.message).toBe("Espera unos segundos antes de volver a actualizar.");
      expect(publicaciones).toEqual([]);
    });

    it("pasados 10 s acepta otra petición", async () => {
      await cambiarInstalacion(instA, { logs_requested_at: new Date(Date.now() - 11_000).toISOString() });
      await requestLogsUploadAs(adminA, tenantA, instA);
      expect(publicaciones).toHaveLength(2);
    });

    it("si EMQX rechaza un panel, sigue con los demás", async () => {
      rechazar.add(P.p1.code);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await requestLogsUploadAs(tecnicoA, tenantA, instA);
      expect(publicaciones.map((p) => p.topic)).toEqual([`acc/${P.p4.code}/cmd`]);
      expect(r.panels).toHaveLength(3);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });

  describe("logsUploadStatusAs", () => {
    it("pendientes: paneles activos en línea sin subida posterior a `since`", async () => {
      const { error } = await admin
        .from("panels")
        .update({ logs_uploaded_at: null })
        .in("id", [P.p1.id, P.p2.id, P.p3.id, P.p4.id]);
      if (error) throw error;
      const since = new Date().toISOString();
      expect((await logsUploadStatusAs(tecnicoA, tenantA, instA, since)).pending.sort()).toEqual(
        [P.p1.id, P.p4.id].sort(),
      );

      const viejo = new Date(Date.parse(since) - 5000).toISOString();
      const nuevo = new Date(Date.parse(since) + 1000).toISOString();
      await admin.from("panels").update({ logs_uploaded_at: nuevo }).eq("id", P.p1.id);
      await admin.from("panels").update({ logs_uploaded_at: viejo }).eq("id", P.p4.id);
      expect((await logsUploadStatusAs(tecnicoA, tenantA, instA, since)).pending).toEqual([P.p4.id]);

      await admin.from("panels").update({ logs_uploaded_at: nuevo }).eq("id", P.p4.id);
      expect((await logsUploadStatusAs(tecnicoA, tenantA, instA, since)).pending).toEqual([]);
    });

    it("una fecha que no es ISO da 400", async () => {
      expect((await fallo(logsUploadStatusAs(tecnicoA, tenantA, instA, "ayer"))).status).toBe(400);
    });
  });

  describe("testOutputAs", () => {
    it("con el panel fuera de línea da 409 «Panel sin conexión» sin publicar ni guardar la orden", async () => {
      const e = await fallo(testOutputAs(tecnicoA, tenantA, instA, S.s2));
      expect(e.status).toBe(409);
      expect(e.message).toBe("Panel sin conexión");
      expect(publicaciones).toEqual([]);
      expect(await ordenesDe(P.p2.id)).toEqual([]);
    });

    it("guarda la orden y publica el payload correcto con expires_at en ISO UTC", async () => {
      const antes = Date.now();
      const { commandId } = await testOutputAs(tecnicoA, tenantA, instA, S.s1);

      expect(publicaciones).toHaveLength(1);
      const { topic, payload } = publicaciones[0];
      expect(topic).toBe(`acc/${P.p1.code}/cmd`);
      expect(Object.keys(payload).sort()).toEqual(["command_id", "expires_at", "output", "requested_by", "type"]);
      expect(payload).toMatchObject({
        type: "test_output",
        command_id: commandId,
        output: 1,
        requested_by: correo("tecnico-a"),
      });
      const expiresAt = String(payload.expires_at);
      expect(expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(expiresAt) - antes).toBeGreaterThanOrEqual(9000);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(10_000);

      const [orden] = await ordenesDe(P.p1.id);
      expect(orden).toMatchObject({
        id: commandId,
        tenant_id: tenantA,
        installation_id: instA,
        panel_id: P.p1.id,
        kind: "test_output",
        output_index: 1,
        requested_by: correo("tecnico-a"),
        requested_by_user: tecnicoAId,
        status: "pending",
        detail: null,
        finished_at: null,
      });
      expect(Date.parse(orden.expires_at)).toBe(Date.parse(expiresAt));
      expect(await commandStatusAs(tecnicoA, tenantA, instA, commandId)).toEqual({ status: "pending", detail: null });
    });

    it("otra prueba de la misma salida mientras está pendiente da 409", async () => {
      const e = await fallo(testOutputAs(adminA, tenantA, instA, S.s1));
      expect(e.status).toBe(409);
      expect(e.message).toBe("La salida ya se está probando");
      expect(publicaciones).toEqual([]);
    });

    it("commandStatusAs informa expired cuando ya caducó, y la salida se puede volver a probar", async () => {
      const [orden] = await ordenesDe(P.p1.id);
      const { error } = await admin
        .from("panel_commands")
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .eq("id", orden.id);
      if (error) throw error;
      expect(await commandStatusAs(tecnicoA, tenantA, instA, orden.id)).toEqual({ status: "expired", detail: null });

      const { commandId } = await testOutputAs(adminA, tenantA, instA, S.s1);
      expect(commandId).not.toBe(orden.id);
      const ordenes = await ordenesDe(P.p1.id);
      expect(ordenes.find((o) => o.id === orden.id)).toMatchObject({ status: "expired" });
      expect(ordenes.find((o) => o.id === commandId)).toMatchObject({ status: "pending" });
    });

    it("commandStatusAs devuelve el estado y el detalle de una orden terminada", async () => {
      const ordenes = await ordenesDe(P.p1.id);
      const pendiente = ordenes.find((o) => o.status === "pending")!;
      const { error } = await admin
        .from("panel_commands")
        .update({ status: "error", detail: "El daemon no responde", finished_at: new Date().toISOString() })
        .eq("id", pendiente.id);
      if (error) throw error;
      expect(await commandStatusAs(tecnicoA, tenantA, instA, pendiente.id)).toEqual({
        status: "error",
        detail: "El daemon no responde",
      });
    });

    it("si la publicación falla, la orden queda en error y responde 502", async () => {
      rechazar.add(P.p1.code);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const e = await fallo(testOutputAs(tecnicoA, tenantA, instA, S.s1));
      error.mockRestore();
      expect(e.status).toBe(502);
      const ultima = (await ordenesDe(P.p1.id)).at(-1)!;
      expect(ultima).toMatchObject({ status: "error", detail: "No se pudo enviar la orden" });
      expect(ultima.finished_at).not.toBeNull();
    });

    it("una salida de un panel que no está activo da 409; una borrada, de otra instalación o inexistente, 404", async () => {
      expect((await fallo(testOutputAs(tecnicoA, tenantA, instA, S.s3))).status).toBe(409);
      expect((await fallo(testOutputAs(tecnicoA, tenantA, instA, S.sBorrada))).status).toBe(404);
      expect((await fallo(testOutputAs(tecnicoA, tenantA, instA, S.sB))).status).toBe(404);
      expect((await fallo(testOutputAs(tecnicoA, tenantA, instA, randomUUID()))).status).toBe(404);
      expect((await fallo(testOutputAs(tecnicoA, tenantA, instA, "no-es-uuid"))).status).toBe(404);
      expect(publicaciones).toEqual([]);
      expect(await ordenesDe(P.p3.id)).toEqual([]);
    });
  });

  describe("aislamiento entre tenants", () => {
    it("un usuario de otro tenant recibe 403 en las cuatro funciones y no publica nada", async () => {
      const [orden] = await ordenesDe(P.p1.id);
      const llamadas = [
        () => requestLogsUploadAs(adminB, tenantA, instA),
        () => logsUploadStatusAs(adminB, tenantA, instA, new Date().toISOString()),
        () => testOutputAs(adminB, tenantA, instA, S.s1),
        () => commandStatusAs(adminB, tenantA, instA, orden.id),
      ];
      for (const llamada of llamadas) expect((await fallo(llamada())).status).toBe(403);
      expect(publicaciones).toEqual([]);
    });

    it("con su propio tenant pero una instalación ajena, 404", async () => {
      const [orden] = await ordenesDe(P.p1.id);
      expect((await fallo(requestLogsUploadAs(adminB, tenantB, instA))).status).toBe(404);
      expect((await fallo(testOutputAs(adminB, tenantB, instA, S.s1))).status).toBe(404);
      expect((await fallo(commandStatusAs(adminB, tenantB, instA, orden.id))).status).toBe(404);
      expect(publicaciones).toEqual([]);
    });

    it("commandStatusAs de una orden de otra instalación o inexistente da 404", async () => {
      const { data, error } = await admin
        .from("panel_commands")
        .insert({
          tenant_id: tenantB,
          installation_id: instB,
          panel_id: P.pb.id,
          kind: "test_output",
          output_index: 0,
          requested_by: "otro@test.local",
          expires_at: new Date(Date.now() + 10_000).toISOString(),
        })
        .select("id")
        .single<{ id: string }>();
      if (error) throw error;
      expect((await fallo(commandStatusAs(tecnicoA, tenantA, instA, data.id))).status).toBe(404);
      expect((await fallo(commandStatusAs(tecnicoA, tenantA, instA, randomUUID()))).status).toBe(404);
      expect((await fallo(commandStatusAs(tecnicoA, tenantA, instA, "x"))).status).toBe(404);
    });
  });
});
