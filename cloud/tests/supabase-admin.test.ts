import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminSupabase } from "@/lib/supabase/admin";

describe("createAdminSupabase", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("lanza un error si se usa en el navegador", () => {
    vi.stubGlobal("window", {});
    expect(() => createAdminSupabase()).toThrow(/solo puede usarse en el servidor/);
  });

  it("lanza un error en español si faltan las variables", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    expect(() => createAdminSupabase()).toThrow(/Falta NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("crea el cliente en el servidor con las variables presentes", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_de_prueba");
    expect(createAdminSupabase()).toBeDefined();
  });
});
