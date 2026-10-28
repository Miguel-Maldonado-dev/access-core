import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/links";
import {
  INVALID_LINK_PATH,
  confirmEmailLinkAs,
  requestPasswordResetAs,
  safeNextPath,
  setPasswordAs,
  signInAs,
} from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/**
 * Inicio de sesión, enlaces de correo (solo recuperación: token_hash + verifyOtp),
 * recuperación de contraseña y contraseña nueva, contra el Auth local. Las server actions y
 * la página /auth/confirm solo envuelven esto.
 */
const CLAVE = "Clave-de-prueba-123";

function cliente(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
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

describe("acceso con Supabase Auth (N11)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const email = `n11-auth-${sufijo}@test.local`;
  // Cuenta que solo tiene un enlace de invitación viejo: ya no se acepta.
  const invitado = `n11-auth-invitado-${sufijo}@test.local`;
  const sinConfirmar = `n11-auth-sinconfirmar-${sufijo}@test.local`;
  const olvidadizo = `n11-auth-olvido-${sufijo}@test.local`;
  // Usuario aparte para pedir la recuperación: Auth limita la frecuencia de estos correos por usuario.
  const recupera = `n11-auth-recupera-${sufijo}@test.local`;
  const usuarios: string[] = [];

  beforeAll(async () => {
    requireLocalSupabase();
    vi.stubEnv("APP_URL", "http://localhost:3000");
    usuarios.push(
      await createLocalUser(admin, email, CLAVE),
      await createLocalUser(admin, olvidadizo, CLAVE),
      await createLocalUser(admin, recupera, CLAVE),
    );
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const correo of [invitado, sinConfirmar]) {
      const { data, error } = await admin.rpc("auth_user_id_by_email", { p_email: correo });
      if (error) throw new Error(`No se pudo buscar ${correo}: ${error.message}`);
      if (data) usuarios.push(data as string);
    }
    for (const id of usuarios) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`No se pudo borrar el usuario ${id}: ${error.message}`);
    }
  });

  describe("safeNextPath", () => {
    it("solo acepta rutas internas", () => {
      expect(safeNextPath("/t/abc/users?x=1")).toBe("/t/abc/users?x=1");
      expect(safeNextPath("/t/abc/users#seccion")).toBe("/t/abc/users#seccion");
      expect(safeNextPath(undefined)).toBe("/");
      expect(safeNextPath("")).toBe("/");
      expect(safeNextPath("https://otro.example")).toBe("/");
      expect(safeNextPath("//otro.example")).toBe("/");
      expect(safeNextPath("/\\otro.example")).toBe("/");
      expect(safeNextPath("/login")).toBe("/");
      expect(safeNextPath("/login?next=%2Fx")).toBe("/");
    });

    it("rechaza las rutas que el navegador convierte en otro dominio (tabuladores y saltos de línea)", () => {
      expect(safeNextPath("/\t/otro.example")).toBe("/");
      expect(safeNextPath("/\n/otro.example")).toBe("/");
      expect(safeNextPath("/\r\n/otro.example")).toBe("/");
      expect(safeNextPath("/\t\\otro.example")).toBe("/");
      // Lo que devuelve ya está normalizado: el navegador no puede leerlo como otro origen.
      expect(new URL(safeNextPath("/\t/otro.example"), "https://app.example").origin).toBe("https://app.example");
    });

    it("rechaza las rutas internas que al quitar los segmentos de punto empiezan con //", () => {
      for (const next of ["/.//otro.example", "/a/..//otro.example", "/%2e//otro.example", "/./\\otro.example"]) {
        expect(safeNextPath(next), JSON.stringify(next)).toBe("/");
      }
    });

    it("nunca devuelve algo que el navegador lea como otro origen", () => {
      const cargas = [
        "/.//x.example", "/a/..//x.example", "/%2e//x.example", "/./\\x.example", "/%2e%2e//x.example",
        "/a/b/../..//x.example", "/\t/x.example", "/\\/x.example", "//x.example", "/./x", "/t/abc/users?x=1",
      ];
      for (const next of cargas) {
        const destino = safeNextPath(next);
        expect(destino.startsWith("/") && !destino.startsWith("//") && !destino.startsWith("/\\"), JSON.stringify(next)).toBe(true);
        expect(new URL(destino, "https://app.example").origin, JSON.stringify(next)).toBe("https://app.example");
      }
      expect(safeNextPath("/./x")).toBe("/x");
    });
  });

  describe("signInAs", () => {
    it("con la contraseña correcta deja la sesión iniciada", async () => {
      const supabase = cliente();
      await signInAs(supabase, ` ${email.toUpperCase()} `, CLAVE);
      const { data } = await supabase.auth.getClaims();
      expect(data?.claims.sub).toBe(usuarios[0]);
    });

    it("con una cuenta sin confirmar pide que la den de alta de nuevo", async () => {
      const { error } = await admin.auth.admin.createUser({ email: sinConfirmar, password: CLAVE });
      if (error) throw error;
      expect(await fallo(signInAs(cliente(), sinConfirmar, CLAVE))).toEqual({
        status: 400,
        message: "Tu cuenta aún no está activa. Pide a tu administrador que te vuelva a dar de alta.",
      });
    });

    it("con datos incorrectos o vacíos responde en español", async () => {
      expect(await fallo(signInAs(cliente(), email, "otra-clave"))).toEqual({
        status: 400,
        message: "Correo o contraseña incorrectos.",
      });
      expect(await fallo(signInAs(cliente(), "", ""))).toEqual({
        status: 400,
        message: "Escribe tu correo y tu contraseña.",
      });
    });
  });

  describe("confirmEmailLinkAs (enlace de recuperación)", () => {
    it("un enlace de invitación ya no se acepta, aunque el token sea válido", async () => {
      const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email: invitado });
      if (error) throw error;
      const supabase = cliente();
      expect(await confirmEmailLinkAs(supabase, data.properties.hashed_token, "invite")).toBe(INVALID_LINK_PATH);
      const { data: sesion } = await supabase.auth.getClaims();
      expect(sesion).toBeNull();
    });

    it("el aviso del enlace inválido ya no habla de invitaciones", () => {
      expect(INVALID_LINK_MESSAGE).toBe(
        "El enlace no es válido, ya se usó o venció. Usa «¿Olvidaste tu contraseña?» para pedir otro.",
      );
    });

    it("con un token_hash de recuperación válido inicia la sesión y lleva a fijar la contraseña", async () => {
      const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email: olvidadizo });
      if (error) throw error;
      const supabase = cliente();
      expect(await confirmEmailLinkAs(supabase, data.properties.hashed_token, "recovery")).toBe("/contrasena");
      expect(await fallo(setPasswordAs(supabase, "corta", "corta"))).toEqual({
        status: 400,
        message: "La contraseña debe tener al menos 8 caracteres.",
      });
      expect(await fallo(setPasswordAs(supabase, "Nueva-clave-1", "Nueva-clave-2"))).toEqual({
        status: 400,
        message: "Las contraseñas no coinciden.",
      });
      await setPasswordAs(supabase, "Otra-clave-99", "Otra-clave-99");
      await expect(signInLocal(olvidadizo, "Otra-clave-99")).resolves.toBeTruthy();
    });

    it("un enlace inválido, repetido o de otro tipo lleva a /login con el aviso", async () => {
      expect(INVALID_LINK_PATH).toBe("/login?error=enlace");
      expect(await confirmEmailLinkAs(cliente(), "x", "invite")).toBe(INVALID_LINK_PATH);
      expect(await confirmEmailLinkAs(cliente(), "", "invite")).toBe(INVALID_LINK_PATH);
      expect(await confirmEmailLinkAs(cliente(), "x", "signup")).toBe(INVALID_LINK_PATH);

      const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email: olvidadizo });
      if (error) throw error;
      expect(await confirmEmailLinkAs(cliente(), data.properties.hashed_token, "recovery")).toBe("/contrasena");
      expect(await confirmEmailLinkAs(cliente(), data.properties.hashed_token, "recovery")).toBe(INVALID_LINK_PATH);
    });
  });

  describe("requestPasswordResetAs (¿Olvidaste tu contraseña?)", () => {
    async function recuperacionEnviada(id: string): Promise<string | undefined> {
      const { data, error } = await admin.auth.admin.getUserById(id);
      if (error) throw error;
      return data.user.recovery_sent_at;
    }

    it("envía el correo de recuperación a una cuenta existente", async () => {
      const antes = await recuperacionEnviada(usuarios[2]);
      await requestPasswordResetAs(cliente(), ` ${recupera.toUpperCase()} `);
      const despues = await recuperacionEnviada(usuarios[2]);
      expect(despues).toBeTruthy();
      expect(despues).not.toBe(antes);
    });

    it("con un correo sin cuenta responde igual (no revela qué correos existen)", async () => {
      await expect(requestPasswordResetAs(cliente(), `n11-nadie-${sufijo}@test.local`)).resolves.toBeUndefined();
    });

    it("valida el correo", async () => {
      expect(await fallo(requestPasswordResetAs(cliente(), "no-es-correo"))).toEqual({
        status: 400,
        message: "Escribe un correo válido.",
      });
    });
  });

  describe("setPasswordAs", () => {
    it("sin sesión responde 401", async () => {
      expect((await fallo(setPasswordAs(cliente(), "Nueva-clave-1", "Nueva-clave-1"))).status).toBe(401);
    });
  });
});
