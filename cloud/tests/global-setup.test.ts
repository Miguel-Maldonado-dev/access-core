import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import setup from "./global-setup";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_LOCAL",
] as const;

describe("tests/global-setup", () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = Object.fromEntries(VARIABLES.map((k) => [k, process.env[k]]));
    // Valores de un proyecto remoto exportados en el shell.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://remoto.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_remoto";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_remoto";
    process.env.SUPABASE_DB_URL = "postgresql://remoto";
    process.env.SUPABASE_LOCAL = "1";
  });

  afterEach(() => {
    for (const k of VARIABLES) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    vi.mocked(execFileSync).mockReset();
  });

  it("sin stack local borra las variables de Supabase del entorno", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("supabase start no está corriendo");
    });
    setup();
    for (const k of VARIABLES) expect(process.env[k], k).toBeUndefined();
  });

  it("si la salida de supabase status está incompleta también las borra", () => {
    vi.mocked(execFileSync).mockReturnValue('API_URL="http://127.0.0.1:54321"\n');
    setup();
    for (const k of VARIABLES) expect(process.env[k], k).toBeUndefined();
  });

  it("con el stack local arriba exporta sus valores", () => {
    vi.mocked(execFileSync).mockReturnValue(
      [
        'API_URL="http://127.0.0.1:54321"',
        'PUBLISHABLE_KEY="sb_publishable_local"',
        'SECRET_KEY="sb_secret_local"',
        'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
      ].join("\n"),
    );
    setup();
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("sb_publishable_local");
    expect(process.env.SUPABASE_SECRET_KEY).toBe("sb_secret_local");
    expect(process.env.SUPABASE_DB_URL).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(process.env.SUPABASE_LOCAL).toBe("1");
  });
});
