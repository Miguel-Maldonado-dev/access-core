import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as revisionChanged } from "@/app/api/internal/revision-changed/route";
import { POST as mqttAuth } from "@/app/api/mqtt/auth/route";
import { POST as mqttEvents } from "@/app/api/mqtt/events/route";
import { publishToPanel } from "@/lib/mqtt/publish";
import { localAdmin, requireLocalSupabase } from "./helpers/supabase-local";

// Sin broker: `fetch` simulado para la API de EMQX. Base de datos: Supabase LOCAL.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const nuevoCodigo = () => `PNL-${base32(4)}-${base32(4)}`;

const EMQX_SECRET = "secreto-emqx-prueba";
const INTERNAL_SECRET = "secreto-interno-prueba";

/**
 * Simula solo la API de EMQX: el resto de las llamadas (el cliente de Supabase usa el
 * `fetch` global) van al `fetch` real.
 */
type MockEmqx = { (url: string | URL | Request, init?: RequestInit): Promise<Response> | Response };
function stubEmqx(mock: MockEmqx) {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith("http://emqx.test") ? mock(url, init) : real(url, init),
  );
}

function post(url: string, cuerpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(cuerpo),
  });
}

describe("mqtt", () => {
  let admin: SupabaseClient;
  let tenantId: string;
  let installationId: string;
  const creados: string[] = [];
  const instalaciones: string[] = [];
  const entornoOriginal = { ...process.env };

  async function crearInstalacion(): Promise<string> {
    const { data, error } = await admin
      .from("installations")
      .insert({ tenant_id: tenantId, name: `I-mqtt-${base32(6)}` })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    instalaciones.push(data.id);
    return data.id;
  }

  async function crearPanel(estado: string, token: string | null, instalacion = installationId) {
    const code = nuevoCodigo();
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: code,
        panel_secret_hash: sha256(randomBytes(8).toString("hex")),
        device_token_hash: token ? sha256(token) : null,
        installation_id: instalacion,
        status: estado,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    creados.push(data.id);
    return { code, id: data.id as string };
  }

  async function leer(id: string) {
    const { data, error } = await admin
      .from("panels")
      .select("online, last_seen_at, online_event_at")
      .eq("id", id)
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();
    const sufijo = base32(6);
    const t = await admin.from("tenants").insert({ name: `T-mqtt-${sufijo}` }).select("id").single();
    if (t.error) throw new Error(t.error.message);
    tenantId = t.data.id;
    const i = await admin
      .from("installations")
      .insert({ tenant_id: tenantId, name: `I-mqtt-${sufijo}` })
      .select("id")
      .single();
    if (i.error) throw new Error(i.error.message);
    installationId = i.data.id;
  });

  beforeEach(() => {
    process.env.EMQX_WEBHOOK_SECRET = EMQX_SECRET;
    process.env.INTERNAL_WEBHOOK_SECRET = INTERNAL_SECRET;
    process.env.EMQX_API_URL = "http://emqx.test:18083";
    process.env.EMQX_API_KEY = "llave";
    process.env.EMQX_API_SECRET = "secreto-api";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...entornoOriginal };
  });

  afterAll(async () => {
    if (creados.length) await admin.from("panels").delete().in("id", creados);
    await admin.from("installations").delete().in("id", [installationId, ...instalaciones]);
    await admin.from("tenants").delete().eq("id", tenantId);
  });

  describe("/api/mqtt/auth", () => {
    const auth = (cuerpo: unknown, secreto: string | null = EMQX_SECRET) =>
      mqttAuth(post("/api/mqtt/auth", cuerpo, secreto ? { "x-emqx-secret": secreto } : {}));

    it("allow con el token correcto (activo, staging y awaiting_review)", async () => {
      for (const estado of ["active", "staging", "awaiting_review"]) {
        const token = randomBytes(32).toString("base64url");
        const p = await crearPanel(estado, token);
        const res = await auth({ username: p.code, clientid: p.code, password: token });
        expect(await res.json()).toEqual({ result: "allow" });
      }
    });

    it("deny con token incorrecto, panel inexistente o sin credencial", async () => {
      const token = randomBytes(32).toString("base64url");
      const p = await crearPanel("active", token);
      expect(await (await auth({ username: p.code, clientid: p.code, password: "otro" })).json()).toEqual({ result: "deny" });
      expect(await (await auth({ username: nuevoCodigo(), password: token })).json()).toEqual({ result: "deny" });
      const sin = await crearPanel("claimed", null);
      expect(await (await auth({ username: sin.code, clientid: sin.code, password: token })).json()).toEqual({ result: "deny" });
      expect(await (await auth({ username: p.code })).json()).toEqual({ result: "deny" });
    });

    it("deny si el clientid no es el panel_code del usuario (no puede expulsar a otro panel)", async () => {
      const token = randomBytes(32).toString("base64url");
      const p = await crearPanel("active", token);
      const otro = await crearPanel("active", randomBytes(32).toString("base64url"));
      expect(await (await auth({ username: p.code, clientid: otro.code, password: token })).json()).toEqual({
        result: "deny",
      });
      expect(await (await auth({ username: p.code, clientid: "", password: token })).json()).toEqual({
        result: "deny",
      });
      expect(await (await auth({ username: p.code, password: token })).json()).toEqual({ result: "deny" });
      expect(await (await auth({ username: p.code, clientid: p.code, password: token })).json()).toEqual({
        result: "allow",
      });
    });

    it("deny si el panel está revocado", async () => {
      const token = randomBytes(32).toString("base64url");
      const p = await crearPanel("active", token);
      const { error } = await admin
        .from("panels")
        .update({ status: "revoked", device_token_hash: null })
        .eq("id", p.id);
      expect(error).toBeNull();
      expect(await (await auth({ username: p.code, clientid: p.code, password: token })).json()).toEqual({ result: "deny" });
    });

    it("deny sin el encabezado x-emqx-secret o con uno incorrecto", async () => {
      const token = randomBytes(32).toString("base64url");
      const p = await crearPanel("active", token);
      expect(await (await auth({ username: p.code, clientid: p.code, password: token }, null)).json()).toEqual({ result: "deny" });
      expect(await (await auth({ username: p.code, clientid: p.code, password: token }, "mal")).json()).toEqual({ result: "deny" });
    });
  });

  describe("/api/mqtt/events", () => {
    const evento = (cuerpo: unknown, secreto: string | null = EMQX_SECRET) =>
      mqttEvents(post("/api/mqtt/events", cuerpo, secreto ? { "x-emqx-secret": secreto } : {}));

    it("sin secreto responde 401", async () => {
      const res = await evento({ event: "client.connected", username: "x", timestamp: 1 }, null);
      expect(res.status).toBe(401);
      expect((await res.json()).detail).toMatch(/\S/);
    });

    it("conectado pone online=true y desconectado online=false", async () => {
      const p = await crearPanel("active", randomBytes(32).toString("base64url"));
      const t0 = Date.now();
      expect((await evento({ event: "client.connected", username: p.code, timestamp: t0 })).status).toBe(200);
      const a = await leer(p.id);
      expect(a.online).toBe(true);
      expect(new Date(a.last_seen_at).getTime()).toBe(t0);
      await evento({ event: "client.disconnected", username: p.code, timestamp: t0 + 1000 });
      expect((await leer(p.id)).online).toBe(false);
    });

    it("un evento más viejo no pisa a uno más nuevo", async () => {
      const p = await crearPanel("active", randomBytes(32).toString("base64url"));
      const t0 = Date.now();
      await evento({ event: "client.disconnected", username: p.code, timestamp: t0 });
      await evento({ event: "client.connected", username: p.code, timestamp: t0 + 5000 });
      // La desconexión de la sesión anterior llega tarde.
      await evento({ event: "client.disconnected", username: p.code, timestamp: t0 + 1000 });
      const f = await leer(p.id);
      expect(f.online).toBe(true);
      expect(new Date(f.online_event_at).getTime()).toBe(t0 + 5000);
    });

    it("ignora usuarios desconocidos y eventos de otro tipo", async () => {
      expect((await evento({ event: "client.connected", username: nuevoCodigo(), timestamp: 1 })).status).toBe(200);
      expect((await evento({ event: "session.subscribed", username: "x", timestamp: 1 })).status).toBe(200);
    });
  });

  describe("publishToPanel", () => {
    it("manda QoS 1, sin retain y con autenticación básica", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      stubEmqx(fetchMock);
      await publishToPanel("PNL-AAAA-BBBB", { type: "sync", revision: 7 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://emqx.test:18083/api/v5/publish");
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe(`Basic ${Buffer.from("llave:secreto-api").toString("base64")}`);
      const cuerpo = JSON.parse(init.body);
      expect(cuerpo.topic).toBe("acc/PNL-AAAA-BBBB/cmd");
      expect(cuerpo.qos).toBe(1);
      expect(cuerpo.retain).toBeFalsy();
      expect(JSON.parse(cuerpo.payload)).toEqual({ type: "sync", revision: 7 });
    });

    it("falla con un mensaje claro si faltan variables, sin revelar secretos", async () => {
      delete process.env.EMQX_API_KEY;
      await expect(publishToPanel("PNL-AAAA-BBBB", {})).rejects.toThrow(/EMQX_API_KEY/);
    });

    it("falla si EMQX responde con error, sin incluir el secreto", async () => {
      stubEmqx(vi.fn().mockResolvedValue(new Response("no", { status: 500 })));
      const error = await publishToPanel("PNL-AAAA-BBBB", {}).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/500/);
      expect((error as Error).message).not.toContain("secreto-api");
    });
  });

  describe("/api/internal/revision-changed", () => {
    const aviso = (cuerpo: unknown, secreto: string | null = INTERNAL_SECRET) =>
      revisionChanged(
        post("/api/internal/revision-changed", cuerpo, secreto ? { "x-internal-secret": secreto } : {}),
      );

    it("sin secreto o con uno incorrecto responde 401", async () => {
      const cuerpo = { installation_id: installationId, revision: 3 };
      expect((await aviso(cuerpo, null)).status).toBe(401);
      expect((await aviso(cuerpo, "mal")).status).toBe(401);
    });

    it("publica una vez por panel activo y ninguna para los revocados", async () => {
      const inst = await crearInstalacion();
      const a1 = await crearPanel("active", randomBytes(32).toString("base64url"), inst);
      const a2 = await crearPanel("active", randomBytes(32).toString("base64url"), inst);
      const st = await crearPanel("staging", randomBytes(32).toString("base64url"), inst);
      const rev = await crearPanel("revoked", null, inst);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      stubEmqx(fetchMock);

      const res = await aviso({ installation_id: inst, revision: 42 });
      expect(res.status).toBe(200);
      const topics = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).topic).sort();
      expect(topics).toEqual([`acc/${a1.code}/cmd`, `acc/${a2.code}/cmd`].sort());
      expect(topics).not.toContain(`acc/${rev.code}/cmd`);
      expect(topics).not.toContain(`acc/${st.code}/cmd`);
      const cuerpo = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(JSON.parse(cuerpo.payload)).toEqual({ type: "sync", revision: 42 });
      expect(await res.json()).toEqual({ panels: 2, published: 2, failed: 0 });
    });

    it("si un publish falla sigue con los demás y resume", async () => {
      const inst = await crearInstalacion();
      await crearPanel("active", randomBytes(32).toString("base64url"), inst);
      await crearPanel("active", randomBytes(32).toString("base64url"), inst);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("no", { status: 503 }))
        .mockResolvedValue(new Response("{}", { status: 200 }));
      stubEmqx(fetchMock);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await aviso({ installation_id: inst, revision: 9 });
      expect(res.status).toBe(200);
      const resumen = await res.json();
      expect(resumen.failed).toBe(1);
      expect(resumen.published).toBe(resumen.panels - 1);
      expect(fetchMock.mock.calls.length).toBe(resumen.panels);
    });

    it("cuerpo inválido responde 400", async () => {
      expect((await aviso({ installation_id: "no-es-uuid", revision: 1 })).status).toBe(400);
    });
  });
});
