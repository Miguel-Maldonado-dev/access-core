import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireTenantRole } from "@/lib/auth/guards";
import { HttpError } from "@/lib/errors";
import {
  addTenantAdminAs,
  createTenantAs,
  listTenantsAs,
  setTenantSuspendedAs,
} from "@/lib/tenants/admin";
import {
  LAST_ADMIN_MESSAGE,
  addMemberAs,
  changeMemberRoleAs,
  listMembersAs,
  listMyTenantsAs,
  removeMemberAs,
} from "@/lib/tenants/members";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/**
 * Lógica de /admin/tenants y /t/[tenant]/users contra el Supabase local: la autorización,
 * el alta de cuentas sin invitación (correo nuevo → cuenta confirmada con la contraseña dada;
 * sin confirmar → se le pone la contraseña y se confirma; confirmada → solo membresía y su
 * contraseña no cambia), la atomicidad del alta y la regla "al menos un administrador"
 * (trigger de la migración tenant_admin_guard).
 */
const CLAVE = "Clave-de-prueba-123";
const CLAVE_NUEVA = "Clave-nueva-456";
const PENDIENTE_MSG =
  "Ese correo tiene una cuenta pendiente en otra organización. Pide al súper administrador que la active.";
const CORTA_MSG = "La contraseña debe tener al menos 8 caracteres.";

/** Correos de las cuentas que crean las pruebas (el `afterAll` las busca y borra). */
const CUENTAS_CREADAS = ["nuevo-admin", "nuevo-tecnico", "sin-confirmar", "otro-admin", "fallida", "fallida-miembro", "pendiente-b", "pendiente-super", "pendiente-libre", "pendiente-plataforma"];

/**
 * Cliente que se comporta como `cliente` salvo que el insert en `tenant_members` falla:
 * sirve para probar que un alta fallida no deja tenant ni usuario.
 */
function sinInsertarMembresias(cliente: SupabaseClient): SupabaseClient {
  const delegar = (objeto: object, propiedad: string | symbol) => {
    const valor = Reflect.get(objeto, propiedad);
    return typeof valor === "function" ? valor.bind(objeto) : valor;
  };
  return new Proxy(cliente, {
    get(destino, propiedad) {
      if (propiedad !== "from") return delegar(destino, propiedad);
      return (tabla: string) => {
        const consulta = destino.from(tabla);
        if (tabla !== "tenant_members") return consulta;
        return new Proxy(consulta, {
          get: (q, p) =>
            p === "insert"
              ? () => Promise.resolve({ error: { code: "XX000", message: "fallo simulado" } })
              : delegar(q, p),
        });
      };
    },
  });
}

async function fallo(promesa: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promesa;
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error("Se esperaba un HttpError y la operación salió bien.");
}

describe("administración de tenants y miembros (N11)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  // Auth guarda los correos en minúsculas.
  const correo = (nombre: string) => `n11-tm-${nombre}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const tenants: string[] = [];
  /** Filas de `platform_admins` que crean las pruebas (se borran antes que los usuarios). */
  const superAdminsCreados: string[] = [];
  let superAdmin: SupabaseClient;
  let adminA: SupabaseClient;
  let tecnicoA: SupabaseClient;
  let ids: Record<"super" | "adminA" | "tecnicoA" | "existente" | "otro", string>;
  let tenantA: string;
  let tenantNuevo: string;

  /** Usuario de Auth (para ver si su correo quedó confirmado). */
  async function usuarioAuth(id: string) {
    const { data, error } = await admin.auth.admin.getUserById(id);
    if (error) throw error;
    return data.user;
  }

  async function idPorCorreo(email: string): Promise<string | null> {
    const { data, error } = await admin.rpc("auth_user_id_by_email", { p_email: email });
    if (error) throw error;
    return data as string | null;
  }

  async function miembros(tenantId: string) {
    const { data, error } = await admin
      .from("tenant_members")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .order("user_id");
    if (error) throw error;
    return data;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const nombres = ["super", "adminA", "tecnicoA", "existente", "otro"] as const;
    const creados = await Promise.all(nombres.map((n) => createLocalUser(admin, correo(n), CLAVE)));
    usuarios.push(...creados);
    ids = Object.fromEntries(nombres.map((n, i) => [n, creados[i]])) as typeof ids;

    const { error: e1 } = await admin.from("platform_admins").insert({ user_id: ids.super });
    if (e1) throw e1;
    const { data: t, error: e2 } = await admin
      .from("tenants")
      .insert({ name: `Tenant A ${sufijo}` })
      .select("id")
      .single<{ id: string }>();
    if (e2) throw e2;
    tenantA = t.id;
    tenants.push(tenantA);
    const { error: e3 } = await admin.from("tenant_members").insert([
      { tenant_id: tenantA, user_id: ids.adminA, role: "admin" },
      { tenant_id: tenantA, user_id: ids.tecnicoA, role: "tecnico" },
    ]);
    if (e3) throw e3;

    [superAdmin, adminA, tecnicoA] = await Promise.all(
      (["super", "adminA", "tecnicoA"] as const).map((n) => signInLocal(correo(n), CLAVE)),
    );
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    // Primero los tenants (borran sus membresías), al final los usuarios.
    if (tenants.length) {
      const { error } = await admin.from("tenants").delete().in("id", tenants);
      if (error) throw new Error(`No se pudieron borrar los tenants de prueba: ${error.message}`);
    }
    if (superAdminsCreados.length) {
      const { error } = await admin.from("platform_admins").delete().in("user_id", superAdminsCreados);
      if (error) throw new Error(`No se pudieron borrar los súper administradores de prueba: ${error.message}`);
    }
    // Cuentas que crearon las pruebas por el alta.
    for (const nombre of CUENTAS_CREADAS) {
      const id = await idPorCorreo(correo(nombre));
      if (id) usuarios.push(id);
    }
    for (const id of usuarios) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`No se pudo borrar el usuario ${id}: ${error.message}`);
    }
  });

  /** Nombres de tenant de esta ejecución que existen en la base. */
  async function tenantsConNombre(prefijo: string): Promise<number> {
    const { data, error } = await admin.from("tenants").select("id").like("name", `${prefijo}%`);
    if (error) throw error;
    return data.length;
  }

  describe("tenants (súper administrador)", () => {
    it("quien no es súper administrador no puede crear, listar, suspender ni agregar administradores (403)", async () => {
      expect((await fallo(createTenantAs(adminA, "X", correo("otro"), CLAVE))).status).toBe(403);
      expect((await fallo(listTenantsAs(adminA))).status).toBe(403);
      expect((await fallo(setTenantSuspendedAs(adminA, tenantA, true))).status).toBe(403);
      expect((await fallo(addTenantAdminAs(tecnicoA, tenantA, correo("otro"), CLAVE))).status).toBe(403);
    });

    it("valida el nombre y el correo con mensajes en español", async () => {
      expect(await fallo(createTenantAs(superAdmin, "   ", correo("otro"), CLAVE))).toEqual({
        status: 400,
        message: "Escribe el nombre del tenant.",
      });
      expect(await fallo(createTenantAs(superAdmin, "Bien", "no-es-correo", CLAVE))).toEqual({
        status: 400,
        message: "Escribe un correo válido.",
      });
    });

    it("con contraseña corta responde 400 y no crea tenant ni usuario", async () => {
      expect(await fallo(createTenantAs(superAdmin, `Corta ${sufijo}`, correo("fallida"), "corta"))).toEqual({
        status: 400,
        message: CORTA_MSG,
      });
      expect(await tenantsConNombre(`Corta ${sufijo}`)).toBe(0);
      expect(await idPorCorreo(correo("fallida"))).toBeNull();
    });

    it("con una contraseña de más de 72 caracteres responde 400 y no crea nada", async () => {
      expect(await fallo(createTenantAs(superAdmin, `Larga ${sufijo}`, correo("fallida"), "a".repeat(73)))).toEqual({
        status: 400,
        message: "La contraseña admite hasta 72 caracteres.",
      });
      expect(await tenantsConNombre(`Larga ${sufijo}`)).toBe(0);
      expect(await idPorCorreo(correo("fallida"))).toBeNull();
    });

    it("con un correo que ya tiene cuenta confirmada, crea el tenant y la membresía sin cambiar su contraseña", async () => {
      const r = await createTenantAs(superAdmin, `  Con cuenta ${sufijo} `, correo("existente").toUpperCase(), CLAVE_NUEVA);
      tenants.push(r.tenantId);
      expect(r.existingAccount).toBe(true);
      expect(await miembros(r.tenantId)).toEqual([{ user_id: ids.existente, role: "admin" }]);
      const { data } = await admin.from("tenants").select("name").eq("id", r.tenantId).single();
      expect(data?.name).toBe(`Con cuenta ${sufijo}`);
      // La contraseña de siempre sigue sirviendo; la que escribió el súper administrador, no.
      await expect(signInLocal(correo("existente"), CLAVE)).resolves.toBeTruthy();
      await expect(signInLocal(correo("existente"), CLAVE_NUEVA)).rejects.toThrow();
    });

    it("con un correo nuevo crea la cuenta confirmada, que inicia sesión, y la membresía de admin", async () => {
      const r = await createTenantAs(superAdmin, `Nuevo ${sufijo}`, correo("nuevo-admin"), CLAVE_NUEVA);
      tenants.push(r.tenantId);
      tenantNuevo = r.tenantId;
      expect(r.existingAccount).toBe(false);
      const id = await idPorCorreo(correo("nuevo-admin"));
      expect(id).toBeTruthy();
      const usuario = await usuarioAuth(id!);
      expect(usuario.email_confirmed_at).toBeTruthy();
      expect(usuario.invited_at).toBeFalsy();
      expect(await miembros(r.tenantId)).toEqual([{ user_id: id, role: "admin" }]);
      const sesion = await signInLocal(correo("nuevo-admin"), CLAVE_NUEVA);
      expect((await requireTenantRole(r.tenantId, "admin", sesion)).role).toBe("admin");
      // La respuesta no devuelve la contraseña.
      expect(JSON.stringify(r)).not.toContain(CLAVE_NUEVA);
    });

    it("con una cuenta sin confirmar le pone la contraseña dada, la confirma y la hace admin", async () => {
      const { data, error } = await admin.auth.admin.createUser({ email: correo("sin-confirmar"), password: CLAVE });
      if (error) throw error;
      expect(data.user.email_confirmed_at).toBeFalsy();
      const r = await createTenantAs(superAdmin, `Sin confirmar ${sufijo}`, correo("sin-confirmar"), CLAVE_NUEVA);
      tenants.push(r.tenantId);
      expect(r.existingAccount).toBe(false);
      expect((await usuarioAuth(data.user.id)).email_confirmed_at).toBeTruthy();
      expect(await miembros(r.tenantId)).toEqual([{ user_id: data.user.id, role: "admin" }]);
      await expect(signInLocal(correo("sin-confirmar"), CLAVE_NUEVA)).resolves.toBeTruthy();
      await expect(signInLocal(correo("sin-confirmar"), CLAVE)).rejects.toThrow();
    });

    it("si falla la membresía, no quedan ni el tenant ni el usuario nuevo", async () => {
      await expect(
        createTenantAs(sinInsertarMembresias(superAdmin), `Fallida ${sufijo}`, correo("fallida"), CLAVE_NUEVA),
      ).rejects.toMatchObject({ code: "XX000" });
      expect(await tenantsConNombre(`Fallida ${sufijo}`)).toBe(0);
      expect(await idPorCorreo(correo("fallida"))).toBeNull();
    });

    it("si la cuenta ya existía y falla la membresía, no se borra la cuenta ni queda el tenant", async () => {
      await expect(
        createTenantAs(sinInsertarMembresias(superAdmin), `Fallida ${sufijo}`, correo("existente"), CLAVE_NUEVA),
      ).rejects.toMatchObject({ code: "XX000" });
      expect(await tenantsConNombre(`Fallida ${sufijo}`)).toBe(0);
      expect(await idPorCorreo(correo("existente"))).toBe(ids.existente);
    });

    it("lista los tenants con sus administradores", async () => {
      const lista = await listTenantsAs(superAdmin);
      const nuevo = lista.find((t) => t.name === `Nuevo ${sufijo}`);
      expect(nuevo?.suspendedAt).toBeNull();
      const idNuevo = await idPorCorreo(correo("nuevo-admin"));
      expect(nuevo?.admins).toEqual([{ userId: idNuevo, email: correo("nuevo-admin") }]);
      const a = lista.find((t) => t.id === tenantA);
      expect(a?.admins).toEqual([{ userId: ids.adminA, email: correo("adminA") }]);
    });

    it("agrega a otro administrador a un tenant existente con cuenta nueva que inicia sesión", async () => {
      expect(await addTenantAdminAs(superAdmin, tenantNuevo, correo("otro-admin"), CLAVE_NUEVA)).toEqual({
        existingAccount: false,
      });
      const id = (await idPorCorreo(correo("otro-admin")))!;
      expect((await usuarioAuth(id)).email_confirmed_at).toBeTruthy();
      expect((await miembros(tenantNuevo)).find((m) => m.user_id === id)?.role).toBe("admin");
      const sesion = await signInLocal(correo("otro-admin"), CLAVE_NUEVA);
      expect((await requireTenantRole(tenantNuevo, "admin", sesion)).role).toBe("admin");
    });

    it("al agregar administrador con cuenta confirmada no cambia su contraseña", async () => {
      expect(await addTenantAdminAs(superAdmin, tenantNuevo, correo("otro"), CLAVE_NUEVA)).toEqual({
        existingAccount: true,
      });
      expect((await miembros(tenantNuevo)).find((m) => m.user_id === ids.otro)?.role).toBe("admin");
      await expect(signInLocal(correo("otro"), CLAVE)).resolves.toBeTruthy();
      await expect(signInLocal(correo("otro"), CLAVE_NUEVA)).rejects.toThrow();
    });

    it("agregar administrador valida la contraseña y respeta el 403", async () => {
      expect(await fallo(addTenantAdminAs(superAdmin, tenantA, correo("fallida"), "corta"))).toEqual({
        status: 400,
        message: CORTA_MSG,
      });
      expect(await idPorCorreo(correo("fallida"))).toBeNull();
      expect((await fallo(addTenantAdminAs(adminA, tenantA, correo("fallida"), CLAVE_NUEVA))).status).toBe(403);
      expect(await idPorCorreo(correo("fallida"))).toBeNull();
    });

    it("si falla la membresía al agregar administrador, no queda el usuario nuevo", async () => {
      await expect(
        addTenantAdminAs(sinInsertarMembresias(superAdmin), tenantA, correo("fallida"), CLAVE_NUEVA),
      ).rejects.toMatchObject({ code: "XX000" });
      expect(await idPorCorreo(correo("fallida"))).toBeNull();
    });

    it("agregar como admin a quien ya es miembro responde 409", async () => {
      expect(await fallo(addTenantAdminAs(superAdmin, tenantA, correo("tecnicoA"), CLAVE_NUEVA))).toEqual({
        status: 409,
        message: "Ese correo ya es miembro del tenant.",
      });
    });

    it("suspende y reactiva: suspendido, sus miembros pierden el acceso", async () => {
      await setTenantSuspendedAs(superAdmin, tenantA, true);
      const lista = await listTenantsAs(superAdmin);
      expect(lista.find((t) => t.id === tenantA)?.suspendedAt).toBeTruthy();
      expect((await fallo(requireTenantRole(tenantA, "tecnico", adminA))).status).toBe(403);

      await setTenantSuspendedAs(superAdmin, tenantA, false);
      expect((await requireTenantRole(tenantA, "admin", adminA)).role).toBe("admin");
    });

    it("el inicio lista los tenants del usuario con su rol; uno suspendido ya no aparece", async () => {
      expect(await listMyTenantsAs(tecnicoA)).toEqual([
        { id: tenantA, name: `Tenant A ${sufijo}`, role: "tecnico", suspended: false },
      ]);
      await setTenantSuspendedAs(superAdmin, tenantA, true);
      expect(await listMyTenantsAs(tecnicoA)).toEqual([]);
      await setTenantSuspendedAs(superAdmin, tenantA, false);
      expect(await listMyTenantsAs(superAdmin)).toEqual([]);
    });

    it("suspender un tenant que no existe responde 404", async () => {
      expect(await fallo(setTenantSuspendedAs(superAdmin, randomUUID(), true))).toEqual({
        status: 404,
        message: "El tenant no existe.",
      });
    });
  });

  describe("miembros (admin del tenant)", () => {
    it("un técnico no puede listar, agregar, cambiar roles ni quitar (403)", async () => {
      expect((await fallo(listMembersAs(tecnicoA, tenantA))).status).toBe(403);
      expect((await fallo(addMemberAs(tecnicoA, tenantA, correo("fallida-miembro"), CLAVE_NUEVA, "tecnico"))).status).toBe(403);
      expect((await fallo(changeMemberRoleAs(tecnicoA, tenantA, ids.tecnicoA, "admin"))).status).toBe(403);
      expect((await fallo(removeMemberAs(tecnicoA, tenantA, ids.adminA))).status).toBe(403);
    });

    it("el admin lista a los miembros con su correo y su rol", async () => {
      const lista = await listMembersAs(adminA, tenantA);
      expect(lista).toEqual(
        [
          { userId: ids.adminA, email: correo("adminA"), role: "admin" },
          { userId: ids.tecnicoA, email: correo("tecnicoA"), role: "tecnico" },
        ].sort((a, b) => a.email.localeCompare(b.email)),
      );
    });

    it("agrega a un técnico con correo nuevo: cuenta confirmada que inicia sesión", async () => {
      expect(await addMemberAs(adminA, tenantA, correo("nuevo-tecnico"), CLAVE_NUEVA, "tecnico")).toEqual({
        existingAccount: false,
      });
      const id = (await idPorCorreo(correo("nuevo-tecnico")))!;
      expect((await usuarioAuth(id)).email_confirmed_at).toBeTruthy();
      expect((await miembros(tenantA)).find((m) => m.user_id === id)?.role).toBe("tecnico");
      const sesion = await signInLocal(correo("nuevo-tecnico"), CLAVE_NUEVA);
      expect((await requireTenantRole(tenantA, "tecnico", sesion)).role).toBe("tecnico");
    });

    it("con cuenta confirmada solo agrega la membresía y no cambia su contraseña", async () => {
      expect(await addMemberAs(adminA, tenantA, correo("otro"), CLAVE_NUEVA, "tecnico")).toEqual({
        existingAccount: true,
      });
      await expect(signInLocal(correo("otro"), CLAVE)).resolves.toBeTruthy();
      await expect(signInLocal(correo("otro"), CLAVE_NUEVA)).rejects.toThrow();
    });

    it("valida la contraseña, rechaza a quien ya es miembro y no deja usuario si falla la membresía", async () => {
      expect(await fallo(addMemberAs(adminA, tenantA, correo("fallida-miembro"), "corta", "tecnico"))).toEqual({
        status: 400,
        message: CORTA_MSG,
      });
      expect(await idPorCorreo(correo("fallida-miembro"))).toBeNull();
      expect(await fallo(addMemberAs(adminA, tenantA, correo("tecnicoA"), CLAVE_NUEVA, "tecnico"))).toEqual({
        status: 409,
        message: "Ese correo ya es miembro del tenant.",
      });
      await expect(
        addMemberAs(sinInsertarMembresias(adminA), tenantA, correo("fallida-miembro"), CLAVE_NUEVA, "tecnico"),
      ).rejects.toMatchObject({ code: "XX000" });
      expect(await idPorCorreo(correo("fallida-miembro"))).toBeNull();
    });

    describe("cuentas sin confirmar (invitación pendiente de antes)", () => {
      let tenantB: string;

      /** Cuenta sin confirmar; con `tenant`, ya es técnico de ese tenant. */
      async function pendiente(nombre: string, tenant?: string): Promise<string> {
        const { data, error } = await admin.auth.admin.createUser({ email: correo(nombre), password: CLAVE });
        if (error) throw error;
        expect(data.user.email_confirmed_at).toBeFalsy();
        if (tenant) {
          const { error: e } = await admin
            .from("tenant_members")
            .insert({ tenant_id: tenant, user_id: data.user.id, role: "tecnico" });
          if (e) throw e;
        }
        return data.user.id;
      }

      beforeAll(async () => {
        const { data, error } = await admin
          .from("tenants")
          .insert({ name: `Tenant B ${sufijo}` })
          .select("id")
          .single<{ id: string }>();
        if (error) throw error;
        tenantB = data.id;
        tenants.push(tenantB);
      });

      it("un admin de tenant no puede adoptar una cuenta pendiente en otro tenant (409) y no cambia nada", async () => {
        const id = await pendiente("pendiente-b", tenantB);
        const antes = await usuarioAuth(id);
        expect(await fallo(addMemberAs(adminA, tenantA, correo("pendiente-b"), CLAVE_NUEVA, "tecnico"))).toEqual({
          status: 409,
          message: PENDIENTE_MSG,
        });
        const despues = await usuarioAuth(id);
        expect(despues.email_confirmed_at).toBeFalsy();
        expect(despues.updated_at).toBe(antes.updated_at);
        expect((await miembros(tenantA)).some((m) => m.user_id === id)).toBe(false);
        expect((await miembros(tenantB)).find((m) => m.user_id === id)?.role).toBe("tecnico");
      });

      it("el súper administrador sí puede adoptarla: queda confirmada, con la contraseña dada y como admin", async () => {
        const id = await pendiente("pendiente-super", tenantB);
        expect(await addTenantAdminAs(superAdmin, tenantNuevo, correo("pendiente-super"), CLAVE_NUEVA)).toEqual({
          existingAccount: false,
        });
        expect((await usuarioAuth(id)).email_confirmed_at).toBeTruthy();
        expect((await miembros(tenantNuevo)).find((m) => m.user_id === id)?.role).toBe("admin");
        await expect(signInLocal(correo("pendiente-super"), CLAVE_NUEVA)).resolves.toBeTruthy();
      });

      it("un admin de tenant no puede adoptar una cuenta pendiente que es súper administradora (409)", async () => {
        const id = await pendiente("pendiente-plataforma");
        const { error } = await admin.from("platform_admins").insert({ user_id: id });
        if (error) throw error;
        superAdminsCreados.push(id);
        const antes = await usuarioAuth(id);
        expect(await fallo(addMemberAs(adminA, tenantA, correo("pendiente-plataforma"), CLAVE_NUEVA, "tecnico"))).toEqual({
          status: 409,
          message: PENDIENTE_MSG,
        });
        const despues = await usuarioAuth(id);
        expect(despues.email_confirmed_at).toBeFalsy();
        expect(despues.updated_at).toBe(antes.updated_at);
        expect((await miembros(tenantA)).some((m) => m.user_id === id)).toBe(false);
      });

      it("una cuenta pendiente sin membresías la adopta un admin de tenant", async () => {
        const id = await pendiente("pendiente-libre");
        expect(await addMemberAs(adminA, tenantA, correo("pendiente-libre"), CLAVE_NUEVA, "tecnico")).toEqual({
          existingAccount: false,
        });
        expect((await usuarioAuth(id)).email_confirmed_at).toBeTruthy();
        expect((await miembros(tenantA)).find((m) => m.user_id === id)?.role).toBe("tecnico");
        await expect(signInLocal(correo("pendiente-libre"), CLAVE_NUEVA)).resolves.toBeTruthy();
      });
    });

    it("quitar al último admin falla con el mensaje", async () => {
      expect(await fallo(removeMemberAs(adminA, tenantA, ids.adminA))).toEqual({
        status: 409,
        message: LAST_ADMIN_MESSAGE,
      });
      expect(LAST_ADMIN_MESSAGE).toBe("El tenant debe tener al menos un administrador.");
    });

    it("degradar al último admin falla con el mensaje", async () => {
      expect(await fallo(changeMemberRoleAs(adminA, tenantA, ids.adminA, "tecnico"))).toEqual({
        status: 409,
        message: "El tenant debe tener al menos un administrador.",
      });
      expect((await miembros(tenantA)).find((m) => m.user_id === ids.adminA)?.role).toBe("admin");
    });

    it("con otro admin, cambia roles y quita miembros; avisa cuando el cambio es propio", async () => {
      expect(await changeMemberRoleAs(adminA, tenantA, ids.tecnicoA, "admin")).toEqual({ self: false });
      expect(await changeMemberRoleAs(adminA, tenantA, ids.adminA, "tecnico")).toEqual({ self: true });
      // adminA ya es técnico: perdió la administración de miembros.
      expect((await fallo(listMembersAs(adminA, tenantA))).status).toBe(403);
      const nuevoAdmin = await signInLocal(correo("tecnicoA"), CLAVE);
      expect(await removeMemberAs(nuevoAdmin, tenantA, ids.otro)).toEqual({ self: false });
      expect((await miembros(tenantA)).some((m) => m.user_id === ids.otro)).toBe(false);
    });

    it("quitar o cambiar a quien no es miembro responde 404", async () => {
      const nuevoAdmin = await signInLocal(correo("tecnicoA"), CLAVE);
      expect(await fallo(removeMemberAs(nuevoAdmin, tenantA, ids.otro))).toEqual({
        status: 404,
        message: "Ese usuario no es miembro del tenant.",
      });
      expect((await fallo(changeMemberRoleAs(nuevoAdmin, tenantA, "no-es-uuid", "admin"))).status).toBe(404);
    });

    it("el admin de un tenant no administra los miembros de otro (403)", async () => {
      const otro = tenants.find((t) => t !== tenantA)!;
      expect((await fallo(listMembersAs(adminA, otro))).status).toBe(403);
      expect((await fallo(addMemberAs(adminA, otro, correo("fallida-miembro"), CLAVE_NUEVA, "admin"))).status).toBe(403);
    });
  });
});
