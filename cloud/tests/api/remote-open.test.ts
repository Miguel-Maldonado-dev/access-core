import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as abrir } from "@/app/api/v1/installations/[installationId]/outputs/[outputId]/open/route";
import type { Panel } from "@/lib/device/auth";
import { recordCommandResult } from "@/lib/device/commands";
import type { CommandResult } from "@/lib/device/contract";
import { remoteOpenLimits } from "@/lib/panel-commands";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Apertura remota de la API pública contra el Supabase LOCAL. Sin broker: `fetch` simulado
// solo para la API de EMQX; la confirmación del panel se simula con `recordCommandResult`.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const AUTOR = { updated_by: "prueba", origin: "cloud" };
const EMQX = "http://emqx.test:18083";

interface Publicacion {
  topic: string;
  payload: Record<string, unknown>;
}
/** Lo que "responde" el panel a una orden publicada; `null` = no responde. */
type Respuesta = Omit<CommandResult, "command_id"> | null;

describe("API pública: apertura remota", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  const paneles: string[] = [];
  const entornoOriginal = { ...process.env };
  const limitesOriginales = { ...remoteOpenLimits };

  let tenantA: string;
  let instA: string;
  let instA2: string;
  let instB: string;
  let secretA: string;
  const P: Record<"enLinea" | "sinConexion" | "staging" | "otro" | "b", Panel> = {} as never;
  const S: Record<"s1" | "s2" | "sSinConexion" | "sStaging" | "sOcupada" | "sB", { id: string; index: number }> =
    {} as never;
  const H: Record<"vivo" | "borrado" | "otraInst", string> = {} as never;

  let publicaciones: Publicacion[] = [];
  /** EMQX rechaza las publicaciones (HTTP 503). */
  let rechazarEmqx = false;
  /** EMQX entrega la orden al panel, pero su respuesta se pierde (error de red). */
  let respuestaPerdida = false;
  /** Lecturas de `awaitCommand` (select status, reason, detail) que fallan con HTTP 500. */
  let lecturasQueFallan = 0;
  let respuesta: Respuesta = { ok: true, reason: 0, detail: "Salida abierta" };
  const confirmaciones: Promise<void>[] = [];

  async function tenant(nombre: string): Promise<string> {
    const { data, error } = await admin.from("tenants").insert({ name: `Remota ${nombre} ${sufijo}` }).select("id").single();
    if (error) throw error;
    tenants.push(data.id);
    return data.id;
  }
  async function instalacion(tenantId: string, name: string): Promise<string> {
    const { data, error } = await admin.from("installations").insert({ tenant_id: tenantId, name }).select("id").single();
    if (error) throw error;
    return data.id;
  }
  async function crearPanel(tenantId: string, installationId: string, status: string, online: boolean): Promise<Panel> {
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
    return { id: data.id, panel_code: code, installation_id: installationId, tenant_id: tenantId, status } as Panel;
  }
  async function crearSalida(installationId: string, panelId: string, index: number) {
    const { data, error } = await admin
      .from("outputs")
      .insert({
        installation_id: installationId,
        panel_id: panelId,
        output_index: index,
        alias: "",
        duration_ms: 3000,
        reader_mask: 1,
        enabled: true,
        ...AUTOR,
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return { id: data.id, index };
  }
  async function titular(installationId: string, name: string, borrado = false) {
    const { data, error } = await admin
      .from("holders")
      .insert({
        installation_id: installationId,
        kind: "persona",
        name,
        deleted_at: borrado ? new Date().toISOString() : null,
        ...AUTOR,
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }
  async function ordenesDe(panelId: string) {
    const { data, error } = await admin.from("panel_commands").select("*").eq("panel_id", panelId).order("created_at");
    if (error) throw error;
    return data;
  }

  const pedir = (
    salida: string,
    opciones: { inst?: string; body?: unknown; idem?: string } = {},
  ) => {
    const { inst = instA, body = { holder_id: H.vivo, requested_by: "Caseta norte" }, idem } = opciones;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${secretA}` };
    if (idem !== undefined) headers["idempotency-key"] = idem;
    return abrir(
      new Request(`http://localhost/api/v1/installations/${inst}/outputs/${salida}/open`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ installationId: inst, outputId: salida }) },
    );
  };

  beforeAll(async () => {
    requireLocalSupabase();
    tenantA = await tenant("A");
    const tenantB = await tenant("B");
    instA = await instalacion(tenantA, "Torre A");
    instA2 = await instalacion(tenantA, "Torre A2");
    instB = await instalacion(tenantB, "Torre B");
    secretA = `acc_${randomBytes(32).toString("base64url")}`;
    const { error } = await admin
      .from("api_keys")
      .insert({ tenant_id: tenantA, name: "Remota", prefix: secretA.slice(0, 12), key_hash: sha256(secretA) });
    if (error) throw error;

    P.enLinea = await crearPanel(tenantA, instA, "active", true);
    P.sinConexion = await crearPanel(tenantA, instA, "active", false);
    P.staging = await crearPanel(tenantA, instA, "staging", true);
    P.otro = await crearPanel(tenantA, instA, "active", true);
    P.b = await crearPanel(tenantB, instB, "active", true);

    S.s1 = await crearSalida(instA, P.enLinea.id, 1);
    S.s2 = await crearSalida(instA, P.enLinea.id, 2);
    S.sSinConexion = await crearSalida(instA, P.sinConexion.id, 0);
    S.sStaging = await crearSalida(instA, P.staging.id, 0);
    S.sOcupada = await crearSalida(instA, P.otro.id, 3);
    S.sB = await crearSalida(instB, P.b.id, 0);

    H.vivo = await titular(instA, "Ana");
    H.borrado = await titular(instA, "Beto", true);
    H.otraInst = await titular(instA2, "Carla");
  });

  beforeEach(() => {
    publicaciones = [];
    rechazarEmqx = false;
    respuestaPerdida = false;
    lecturasQueFallan = 0;
    respuesta = { ok: true, reason: 0, detail: "Salida abierta" };
    process.env.EMQX_API_URL = EMQX;
    process.env.EMQX_API_KEY = "llave";
    process.env.EMQX_API_SECRET = "secreto-api";
    // La Idempotency-Key se guarda como HMAC con esta clave.
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith(EMQX)) {
        const u = decodeURIComponent(String(url instanceof Request ? url.url : url));
        if (lecturasQueFallan > 0 && u.includes("/rest/v1/panel_commands") && u.includes("select=status,reason,detail")) {
          lecturasQueFallan--;
          return Response.json({ message: "falla simulada" }, { status: 500 });
        }
        return real(url, init);
      }
      if (rechazarEmqx) return new Response("no", { status: 503 });
      const cuerpo = JSON.parse(String(init?.body)) as { topic: string; payload: string };
      const payload = JSON.parse(cuerpo.payload) as Record<string, unknown>;
      publicaciones.push({ topic: cuerpo.topic, payload });
      const codigo = cuerpo.topic.split("/")[1];
      const panel = Object.values(P).find((p) => p.panel_code === codigo)!;
      if (respuesta) {
        const r = respuesta;
        // El panel confirma un poco después, mientras la API espera.
        confirmaciones.push(
          new Promise<void>((resolve, reject) =>
            setTimeout(
              () => recordCommandResult(panel, { command_id: String(payload.command_id), ...r }).then(resolve, reject),
              100,
            ),
          ),
        );
      }
      if (respuestaPerdida) throw new TypeError("fetch failed");
      return Response.json({ id: "x" });
    });
  });

  afterEach(async () => {
    await Promise.all(confirmaciones.splice(0));
    vi.unstubAllGlobals();
    process.env = { ...entornoOriginal };
    Object.assign(remoteOpenLimits, limitesOriginales);
    // Libera las salidas para la siguiente prueba.
    const { error } = await admin
      .from("panel_commands")
      .update({ status: "expired", finished_at: new Date().toISOString() })
      .in("panel_id", paneles)
      .eq("status", "pending");
    if (error) throw error;
  });

  afterAll(async () => {
    await admin.from("outputs").delete().in("panel_id", paneles);
    await admin.from("panels").delete().in("id", paneles);
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
  });

  it("un resultado ok da opened y publica el payload exacto", async () => {
    const res = await pedir(S.s1.id);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ status: "opened", reason: 0, detail: "Salida abierta" });
    expect(Object.keys(json.data).sort()).toEqual(["command_id", "detail", "reason", "status"]);

    expect(publicaciones).toHaveLength(1);
    expect(publicaciones[0].topic).toBe(`acc/${P.enLinea.panel_code}/cmd`);
    const { payload } = publicaciones[0];
    expect(payload).toEqual({
      type: "remote_open",
      command_id: json.data.command_id,
      output: 1,
      holder_uuid: H.vivo,
      requested_by: "Caseta norte",
      expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });

    const [orden] = await ordenesDe(P.enLinea.id).then((o) => o.filter((x) => x.id === json.data.command_id));
    expect(orden).toMatchObject({
      kind: "remote_open",
      holder_id: H.vivo,
      output_index: 1,
      requested_by: "Caseta norte",
      requested_by_user: null,
      status: "ok",
      reason: 0,
    });
    const vigencia = Date.parse(orden.expires_at) - Date.parse(orden.created_at);
    expect(vigencia).toBeGreaterThan(9_000);
    expect(vigencia).toBeLessThan(11_000);
    expect(Date.parse(orden.expires_at)).toBe(Date.parse(String(payload.expires_at)));
  });

  it("requested_by largo se recorta a 120 en la orden y el payload", async () => {
    const res = await pedir(S.s1.id, { body: { holder_id: H.vivo, requested_by: "x".repeat(120) } });
    expect(res.status).toBe(200);
    expect(publicaciones[0].payload.requested_by).toBe("x".repeat(120));
    const largo = await pedir(S.s1.id, { body: { holder_id: H.vivo, requested_by: "x".repeat(121) } });
    expect(largo.status).toBe(400);
  });

  it("ok: false con reason 3 da denied con el motivo y el detalle", async () => {
    respuesta = { ok: false, reason: 3, detail: "Sin permiso de apertura remota" };
    const json = await (await pedir(S.s1.id)).json();
    expect(json.data).toMatchObject({ status: "denied", reason: 3, detail: "Sin permiso de apertura remota" });
  });

  it("ok: false con reason 11 o 2 da denied", async () => {
    respuesta = { ok: false, reason: 11, detail: "Titular desconocido" };
    expect((await (await pedir(S.s1.id)).json()).data).toMatchObject({ status: "denied", reason: 11 });
    respuesta = { ok: false, reason: 2, detail: "La salida no existe o está deshabilitada" };
    expect((await (await pedir(S.s2.id)).json()).data).toMatchObject({ status: "denied", reason: 2 });
  });

  it("ok: false con reason 4, con reason 0 (ocupada) o sin reason da failed", async () => {
    respuesta = { ok: false, reason: 4, detail: "No se pudo enviar la orden al relevador." };
    expect((await (await pedir(S.s1.id)).json()).data).toMatchObject({ status: "failed", reason: 4 });
    respuesta = { ok: false, reason: 0, detail: "La salida ya está en uso" };
    expect((await (await pedir(S.s2.id)).json()).data).toEqual(
      expect.objectContaining({ status: "failed", reason: 0, detail: "La salida ya está en uso" }),
    );
    await admin
      .from("panel_commands")
      .update({ status: "expired", finished_at: new Date().toISOString() })
      .in("panel_id", paneles)
      .eq("status", "pending");
    respuesta = { ok: false, detail: "Orden inválida" };
    expect((await (await pedir(S.s1.id)).json()).data).toMatchObject({ status: "failed", reason: null });
  });

  it("sin resultado dentro del plazo da timeout", async () => {
    remoteOpenLimits.waitMs = 400;
    remoteOpenLimits.pollMs = 50;
    respuesta = null;
    const inicio = Date.now();
    const res = await pedir(S.s1.id);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "timeout", reason: null, detail: null });
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(400);
  });

  it("una orden ya caducada (expired) da timeout", async () => {
    remoteOpenLimits.waitMs = 2000;
    remoteOpenLimits.pollMs = 50;
    respuesta = null;
    // Simula el resultado tardío: la orden queda expired antes del plazo de espera.
    const pendiente = pedir(S.s1.id);
    await vi.waitFor(() => expect(publicaciones).toHaveLength(1));
    await admin
      .from("panel_commands")
      .update({ status: "expired", finished_at: new Date().toISOString() })
      .eq("id", String(publicaciones[0].payload.command_id));
    const inicio = Date.now();
    expect((await (await pendiente).json()).data).toMatchObject({ status: "timeout" });
    expect(Date.now() - inicio).toBeLessThan(1500);
  });

  it("el panel fuera de línea o no activo da 409 Panel sin conexión y no publica", async () => {
    for (const salida of [S.sSinConexion.id, S.sStaging.id]) {
      const res = await pedir(salida);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ code: "conflict", message: "Panel sin conexión" });
    }
    expect(publicaciones).toEqual([]);
  });

  it("una orden pendiente en la misma salida da 409", async () => {
    const { error } = await admin.from("panel_commands").insert({
      tenant_id: tenantA,
      installation_id: instA,
      panel_id: P.otro.id,
      kind: "test_output",
      output_index: S.sOcupada.index,
      requested_by: "otra",
      expires_at: new Date(Date.now() + 10_000).toISOString(),
    });
    if (error) throw error;
    const res = await pedir(S.sOcupada.id);
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe("La salida ya tiene una orden en curso.");
    expect(publicaciones).toEqual([]);
  });

  it("un titular de otra instalación, borrado o inexistente da 400", async () => {
    for (const holder of [H.otraInst, H.borrado, randomUUID()]) {
      const res = await pedir(S.s1.id, { body: { holder_id: holder, requested_by: "Caseta" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: "bad_request", message: "El titular no existe." });
    }
    expect(publicaciones).toEqual([]);
  });

  it("la salida de otro tenant o inexistente da 404", async () => {
    for (const salida of [S.sB.id, randomUUID(), "no-uuid"]) {
      const res = await pedir(salida);
      expect(res.status).toBe(404);
      expect((await res.json()).message).toBe("La salida no existe.");
    }
    const otraInst = await pedir(S.sB.id, { inst: instB });
    expect(otraInst.status).toBe(404);
    expect(publicaciones).toEqual([]);
  });

  it("cuerpo inválido da 400", async () => {
    expect((await pedir(S.s1.id, { body: { holder_id: H.vivo } })).status).toBe(400);
    expect((await pedir(S.s1.id, { body: { holder_id: "x", requested_by: "a" } })).status).toBe(400);
    expect((await pedir(S.s1.id, { body: { holder_id: H.vivo, requested_by: "a", extra: 1 } })).status).toBe(400);
    expect((await pedir(S.s1.id, { body: { holder_id: H.vivo, requested_by: "" } })).status).toBe(400);
  });

  it("si EMQX entrega la orden pero su respuesta se pierde, espera el resultado (200 opened, la orden no queda error)", async () => {
    respuestaPerdida = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await pedir(S.s1.id);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ status: "opened", reason: 0 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    const [orden] = (await ordenesDe(P.enLinea.id)).filter((o) => o.id === json.data.command_id);
    expect(orden).toMatchObject({ status: "ok" });
  });

  it("un fallo de red al publicar sin respuesta del panel da 200 timeout, la orden sigue pendiente y el reintento no publica", async () => {
    remoteOpenLimits.waitMs = 400;
    remoteOpenLimits.pollMs = 50;
    respuesta = null;
    respuestaPerdida = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const idem = `abrir-${randomUUID()}`;
    const primera = await pedir(S.s1.id, { idem });
    expect(primera.status).toBe(200);
    const cuerpo = await primera.json();
    expect(cuerpo.data).toMatchObject({ status: "timeout", reason: null, detail: null });
    const [orden] = (await ordenesDe(P.enLinea.id)).filter((o) => o.id === cuerpo.data.command_id);
    expect(orden).toMatchObject({ status: "pending" });

    const segunda = await pedir(S.s1.id, { idem });
    expect(segunda.status).toBe(200);
    expect(segunda.headers.get("idempotent-replayed")).toBe("true");
    expect(await segunda.json()).toEqual(cuerpo);
    expect(publicaciones).toHaveLength(1);
    // La salida sigue ocupada: una orden nueva sin la llave da 409 mientras la primera no vence.
    const otra = await pedir(S.s1.id);
    expect(otra.status).toBe(409);
    expect(publicaciones).toHaveLength(1);
    error.mockRestore();
  });

  it("requested_by con caracteres de control da 400 y no publica", async () => {
    for (const requested_by of ["Caseta\nnorte", "Caseta\u0000", "\u007f", "Caseta\tnorte"]) {
      const res = await pedir(S.s1.id, { body: { holder_id: H.vivo, requested_by } });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toContain("requested_by");
    }
    expect(publicaciones).toEqual([]);
  });

  it("un holder_id en mayúsculas se publica en minúsculas", async () => {
    const res = await pedir(S.s1.id, { body: { holder_id: H.vivo.toUpperCase(), requested_by: "Caseta" } });
    expect(res.status).toBe(200);
    expect(publicaciones[0].payload.holder_uuid).toBe(H.vivo.toLowerCase());
    const [orden] = (await ordenesDe(P.enLinea.id)).filter((o) => o.id === publicaciones[0].payload.command_id);
    expect(orden.holder_id).toBe(H.vivo.toLowerCase());
  });

  it("si EMQX rechaza la publicación (no 2xx), la orden queda error y responde 502 bad_gateway", async () => {
    rechazarEmqx = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await pedir(S.s2.id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      code: "bad_gateway",
      message: "No se pudo enviar la orden al panel. Intenta de nuevo.",
    });
    error.mockRestore();
    const ordenes = await ordenesDe(P.enLinea.id);
    expect(ordenes.at(-1)).toMatchObject({ kind: "remote_open", status: "error", output_index: 2 });
  });

  it("con Idempotency-Key publica una sola vez y repite la misma respuesta", async () => {
    const idem = `abrir-${randomUUID()}`;
    const primera = await pedir(S.s1.id, { idem });
    expect(primera.status).toBe(200);
    const cuerpo = await primera.json();
    expect(cuerpo.data.status).toBe("opened");

    const segunda = await pedir(S.s1.id, { idem });
    expect(segunda.status).toBe(200);
    expect(segunda.headers.get("idempotent-replayed")).toBe("true");
    expect(await segunda.json()).toEqual(cuerpo);
    expect(publicaciones).toHaveLength(1);
  });

  it("si fallan todas las lecturas de la espera responde 200 timeout y el reintento no publica otra vez", async () => {
    remoteOpenLimits.waitMs = 400;
    remoteOpenLimits.pollMs = 50;
    respuesta = null;
    lecturasQueFallan = 1000;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const idem = `abrir-${randomUUID()}`;
    const primera = await pedir(S.s1.id, { idem });
    expect(primera.status).toBe(200);
    const cuerpo = await primera.json();
    expect(cuerpo.data).toMatchObject({ status: "timeout", reason: null, detail: null });

    const segunda = await pedir(S.s1.id, { idem });
    expect(segunda.status).toBe(200);
    expect(segunda.headers.get("idempotent-replayed")).toBe("true");
    expect(await segunda.json()).toEqual(cuerpo);
    expect(publicaciones).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("si falla una lectura de la espera, una lectura posterior trae el resultado", async () => {
    remoteOpenLimits.pollMs = 50;
    lecturasQueFallan = 1;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await pedir(S.s1.id);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "opened", reason: 0 });
    expect(lecturasQueFallan).toBe(0);
    error.mockRestore();
  });

  it("un reintento con la misma Idempotency-Key mientras la primera espera da 409 y no publica", async () => {
    remoteOpenLimits.waitMs = 1000;
    remoteOpenLimits.pollMs = 50;
    respuesta = null;
    const idem = `abrir-${randomUUID()}`;
    const primera = pedir(S.s1.id, { idem });
    await vi.waitFor(() => expect(publicaciones).toHaveLength(1));
    const segunda = await pedir(S.s1.id, { idem });
    expect(segunda.status).toBe(409);
    expect(await segunda.json()).toEqual({ code: "conflict", message: "La petición original sigue en curso." });
    expect((await (await primera).json()).data.status).toBe("timeout");
    expect(publicaciones).toHaveLength(1);
  });

  it("valida la salida antes que el titular: salida ajena con titular inválido da 404", async () => {
    const res = await pedir(S.sB.id, { body: { holder_id: H.otraInst, requested_by: "Caseta" } });
    expect(res.status).toBe(404);
  });
});
