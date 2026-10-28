import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requirePlatformAdmin, requireTenantRole, requireUser } from "@/lib/auth/guards";
import { HttpError } from "@/lib/errors";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/**
 * Guardas de N11 contra el Supabase local, y las páginas protegidas: sin sesión llevan a
 * /login y sin el rol responden 403 (`forbidden()` de Next). Las páginas leen la sesión de
 * las cookies; aquí `createServerSupabase` devuelve el cliente con la sesión de la prueba.
 */
const estado = vi.hoisted(() => ({ sesion: null as SupabaseClient | null }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => {
    if (!estado.sesion) throw new Error("La prueba no fijó la sesión.");
    return estado.sesion;
  },
}));

const { default: UsersPage } = await import("@/app/t/[tenant]/users/page");
const { default: TenantLayout } = await import("@/app/t/[tenant]/layout");
const { default: TenantsPage } = await import("@/app/admin/tenants/page");

const PROHIBIDO = "NEXT_HTTP_ERROR_FALLBACK;403";
const CLAVE = "Clave-de-prueba-123";

/** Ejecuta una página o layout y devuelve "ok" o el digest del error de Next que lanzó. */
async function resultado(render: () => unknown): Promise<string> {
  try {
    await render();
    return "ok";
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
    throw error;
  }
}

function sinSesion(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function codigoDe(promesa: Promise<unknown>): Promise<number | "ok"> {
  try {
    await promesa;
    return "ok";
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
}

describe("guardas y páginas protegidas (N11)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const usuarios: string[] = [];
  let tenantId: string;
  let superAdmin: SupabaseClient;
  let adminTenant: SupabaseClient;
  let tecnico: SupabaseClient;
  let ajeno: SupabaseClient;

  beforeAll(async () => {
    requireLocalSupabase();
    const correo = (nombre: string) => `n11-guardas-${nombre}-${sufijo}@test.local`;
    const [idSuper, idAdmin, idTecnico, idAjeno] = await Promise.all(
      ["super", "admin", "tecnico", "ajeno"].map((n) => createLocalUser(admin, correo(n), CLAVE)),
    );
    usuarios.push(idSuper, idAdmin, idTecnico, idAjeno);

    const { data: tenant, error } = await admin
      .from("tenants")
      .insert({ name: `Guardas ${sufijo}` })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    tenantId = tenant.id;

    const altas = await Promise.all([
      admin.from("platform_admins").insert({ user_id: idSuper }),
      admin.from("tenant_members").insert([
        { tenant_id: tenantId, user_id: idAdmin, role: "admin" },
        { tenant_id: tenantId, user_id: idTecnico, role: "tecnico" },
      ]),
    ]);
    for (const { error: e } of altas) if (e) throw e;

    [superAdmin, adminTenant, tecnico, ajeno] = await Promise.all(
      ["super", "admin", "tecnico", "ajeno"].map((n) => signInLocal(correo(n), CLAVE)),
    );
  });

  afterAll(async () => {
    if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
    await Promise.all(usuarios.map((id) => admin.auth.admin.deleteUser(id)));
  });

  describe("requireUser y requirePlatformAdmin", () => {
    it("sin sesión responden 401", async () => {
      expect(await codigoDe(requireUser(sinSesion()))).toBe(401);
      expect(await codigoDe(requirePlatformAdmin(sinSesion()))).toBe(401);
    });

    it("requirePlatformAdmin responde 403 a quien no es súper administrador, aunque sea admin de un tenant", async () => {
      expect(await codigoDe(requirePlatformAdmin(adminTenant))).toBe(403);
      expect(await codigoDe(requirePlatformAdmin(ajeno))).toBe(403);
    });

    it("requirePlatformAdmin deja pasar al súper administrador", async () => {
      const acceso = await requirePlatformAdmin(superAdmin);
      expect(acceso.userId).toBe(usuarios[0]);
    });
  });

  describe("requireTenantRole", () => {
    it("un técnico no pasa como admin (403) y sí como técnico", async () => {
      expect(await codigoDe(requireTenantRole(tenantId, "admin", tecnico))).toBe(403);
      const acceso = await requireTenantRole(tenantId, "tecnico", tecnico);
      expect(acceso.role).toBe("tecnico");
    });

    it("quien no es miembro recibe 403", async () => {
      expect(await codigoDe(requireTenantRole(tenantId, "tecnico", ajeno))).toBe(403);
    });
  });

  describe("/t/[tenant]/users (solo admin del tenant)", () => {
    const abrir = () => UsersPage({ params: Promise.resolve({ tenant: tenantId }) } as never);

    it("un técnico que abre /t/X/users recibe 403", async () => {
      estado.sesion = tecnico;
      expect(await resultado(abrir)).toBe(PROHIBIDO);
    });

    it("quien no es miembro recibe 403 en la página y en el layout del tenant", async () => {
      estado.sesion = ajeno;
      expect(await resultado(abrir)).toBe(PROHIBIDO);
      expect(
        await resultado(() =>
          TenantLayout({ params: Promise.resolve({ tenant: tenantId }), children: null } as never),
        ),
      ).toBe(PROHIBIDO);
    });

    it("sin sesión lleva a /login", async () => {
      estado.sesion = sinSesion();
      expect(await resultado(abrir)).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login;/);
    });

    it("el admin del tenant sí la abre, y el técnico sí abre el layout del tenant", async () => {
      estado.sesion = adminTenant;
      expect(await resultado(abrir)).toBe("ok");
      estado.sesion = tecnico;
      expect(
        await resultado(() =>
          TenantLayout({ params: Promise.resolve({ tenant: tenantId }), children: null } as never),
        ),
      ).toBe("ok");
    });
  });

  describe("/admin/tenants (solo súper administrador)", () => {
    const abrir = () => TenantsPage();

    it("un no-administrador de plataforma recibe 403, aunque sea admin de un tenant", async () => {
      estado.sesion = adminTenant;
      expect(await resultado(abrir)).toBe(PROHIBIDO);
      estado.sesion = ajeno;
      expect(await resultado(abrir)).toBe(PROHIBIDO);
    });

    it("sin sesión lleva a /login", async () => {
      estado.sesion = sinSesion();
      expect(await resultado(abrir)).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login;/);
    });

    it("el súper administrador sí la abre", async () => {
      estado.sesion = superAdmin;
      expect(await resultado(abrir)).toBe("ok");
    });
  });
});
