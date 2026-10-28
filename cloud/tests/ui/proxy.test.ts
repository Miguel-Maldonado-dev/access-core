import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";
import { createLocalUser, localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

/**
 * Proxy de sesión (src/proxy.ts): no corre en /api/* ni en estáticos; refresca la sesión y
 * lleva a /login a quien no la tenga, salvo en las rutas públicas de acceso.
 */
const BASE = "http://localhost:3000";
const CLAVE = "Clave-de-prueba-123";

const corre = (url: string) => unstable_doesMiddlewareMatch({ config, url });

describe("proxy de sesión (N11)", () => {
  const admin = localAdmin();
  const email = `n11-proxy-${randomUUID().slice(0, 8)}@test.local`;
  let userId: string;
  let cookieSesion: string;

  beforeAll(async () => {
    requireLocalSupabase();
    userId = await createLocalUser(admin, email, CLAVE);
    // Inicia sesión como lo haría el servidor y guarda las cookies que escribiría.
    const tarro = new Map<string, string>();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: {
          getAll: () => [...tarro].map(([name, value]) => ({ name, value })),
          setAll: (cookies) => cookies.forEach(({ name, value }) => tarro.set(name, value)),
        },
      },
    );
    const { error } = await supabase.auth.signInWithPassword({ email, password: CLAVE });
    if (error) throw error;
    cookieSesion = [...tarro].map(([name, value]) => `${name}=${value}`).join("; ");
  });

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("no corre en /api/* (dispositivos, MQTT, internas y salud) ni en estáticos", () => {
    for (const url of [
      "/api/health",
      "/api/device/v1/register",
      "/api/mqtt/auth",
      "/api/internal/revision-changed",
      "/_next/static/chunks/app.js",
      "/_next/image",
      "/favicon.ico",
      "/logo.svg",
    ]) {
      expect(corre(url), url).toBe(false);
    }
  });

  it("corre en las páginas", () => {
    for (const url of ["/", "/login", "/t/abc/users", "/admin/tenants", "/auth/confirm", "/apiario"]) {
      expect(corre(url), url).toBe(true);
    }
  });

  it("sin sesión, /t/... lleva a /login con la ruta de regreso", async () => {
    const res = await proxy(new NextRequest(`${BASE}/t/abc/users?x=1`));
    expect(getRedirectUrl(res)).toBe(`${BASE}/login?next=%2Ft%2Fabc%2Fusers%3Fx%3D1`);
  });

  it("sin sesión, / y /admin/tenants llevan a /login", async () => {
    expect(getRedirectUrl(await proxy(new NextRequest(`${BASE}/`)))).toBe(`${BASE}/login`);
    expect(getRedirectUrl(await proxy(new NextRequest(`${BASE}/admin/tenants`)))).toBe(
      `${BASE}/login?next=%2Fadmin%2Ftenants`,
    );
  });

  it("sin sesión, deja pasar /login, la recuperación y la confirmación de Auth", async () => {
    expect(getRedirectUrl(await proxy(new NextRequest(`${BASE}/login`)))).toBeNull();
    expect(getRedirectUrl(await proxy(new NextRequest(`${BASE}/auth/recuperar`)))).toBeNull();
    expect(getRedirectUrl(await proxy(new NextRequest(`${BASE}/auth/confirm?token_hash=x&type=recovery`)))).toBeNull();
  });

  it("si /api/health llegara al proxy, tampoco lo redirige", async () => {
    expect(getRedirectUrl(await proxy(new NextRequest(`${BASE}/api/health`)))).toBeNull();
  });

  it("con sesión deja pasar /t/... y lleva de /login al inicio", async () => {
    const conSesion = (ruta: string) => new NextRequest(`${BASE}${ruta}`, { headers: { cookie: cookieSesion } });
    expect(getRedirectUrl(await proxy(conSesion("/t/abc/users")))).toBeNull();
    expect(getRedirectUrl(await proxy(conSesion("/login")))).toBe(`${BASE}/`);
  });
});
