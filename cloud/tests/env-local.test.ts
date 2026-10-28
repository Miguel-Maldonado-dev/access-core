import { describe, expect, it } from "vitest";

// Verifica el mecanismo de tests/global-setup.ts; se omite si no hay stack local.
describe.skipIf(process.env.SUPABASE_LOCAL !== "1")("entorno Supabase local", () => {
  it("exporta la URL y las llaves del stack local", () => {
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):/);
    expect(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toMatch(/^sb_publishable_/);
    expect(process.env.SUPABASE_SECRET_KEY).toMatch(/^sb_secret_/);
  });
});
