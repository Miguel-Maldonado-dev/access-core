import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth/guards";
import { authConfirmUrl, isEmailLinkType } from "@/lib/auth/links";
import { parseEmail } from "@/lib/email";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/password-rules";
import { HttpError } from "@/lib/errors";

/**
 * Inicio de sesión, enlaces del correo de recuperación, recuperación y contraseña con
 * Supabase Auth, sobre el cliente que recibe (en la aplicación, el de las
 * cookies). Las server actions de `(auth)` son envoltorios delgados.
 */

export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH };
/** Destino cuando el enlace de un correo no sirve; /login muestra el aviso. */
export const INVALID_LINK_PATH = "/login?error=enlace";
/** Página donde se elige la contraseña (recuperación o cambio). */
export const SET_PASSWORD_PATH = "/contrasena";

/** Origen ficticio para interpretar `next` como lo haría el navegador. */
const ORIGEN_INTERNO = "http://interno.invalid";

/**
 * Ruta interna a la que volver tras iniciar sesión, o "/". Interpreta `next` con el
 * parser de URL del navegador (que, entre otras cosas, quita tabuladores y saltos de
 * línea: "/\t/x" se vuelve "//x") y solo acepta lo que queda en el mismo origen. Devuelve
 * la forma normalizada, que ya no puede leerse como otro dominio. /login da "/" (bucle).
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(next, ORIGEN_INTERNO);
  } catch {
    return "/";
  }
  if (url.origin !== ORIGEN_INTERNO) return "/";
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return "/";
  const destino = url.pathname + url.search + url.hash;
  // Quitar los segmentos de punto puede dejar un "//x" ("/.//x", "/a/..//x", "/%2e//x"),
  // que el navegador lee como otro dominio: se rechaza lo que no sea una ruta simple y se
  // comprueba que, leído otra vez, siga en el mismo origen.
  if (!destino.startsWith("/") || destino.startsWith("//") || destino.startsWith("/\\")) return "/";
  if (new URL(destino, ORIGEN_INTERNO).origin !== ORIGEN_INTERNO) return "/";
  return destino;
}

/** La contraseña tal cual, o `HttpError` 400 si es más corta que `MIN_PASSWORD_LENGTH` o más larga que `MAX_PASSWORD_LENGTH`. */
export function parsePassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `La contraseña admite hasta ${MAX_PASSWORD_LENGTH} caracteres.`);
  }
  return password;
}

/** Inicia sesión con correo y contraseña, o lanza un `HttpError` con el motivo en español. */
export async function signInAs(supabase: SupabaseClient, email: string, password: string): Promise<void> {
  const correo = email.trim().toLowerCase();
  if (correo === "" || password === "") {
    throw new HttpError(400, "Escribe tu correo y tu contraseña.");
  }
  const { error } = await supabase.auth.signInWithPassword({ email: correo, password });
  if (!error) return;
  if (error.code === "invalid_credentials") throw new HttpError(400, "Correo o contraseña incorrectos.");
  if (error.code === "email_not_confirmed") {
    throw new HttpError(400, "Tu cuenta aún no está activa. Pide a tu administrador que te vuelva a dar de alta.");
  }
  if (error.status === 429) throw new HttpError(429, "Demasiados intentos; espera unos minutos.");
  throw error;
}

/**
 * Enlace del correo de recuperación (`/auth/confirm?token_hash=…&type=recovery`),
 * ya con el clic en "Continuar" (POST): verifica el token con `verifyOtp`, que deja la
 * sesión iniciada, y devuelve a dónde ir: a elegir la contraseña, o a /login con el aviso
 * si el enlace no sirve (vencido, usado o de otro tipo).
 */
export async function confirmEmailLinkAs(
  supabase: SupabaseClient,
  tokenHash: string,
  type: string,
): Promise<string> {
  if (!tokenHash || !isEmailLinkType(type)) return INVALID_LINK_PATH;
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  return error ? INVALID_LINK_PATH : SET_PASSWORD_PATH;
}

/**
 * "¿Olvidaste tu contraseña?": pide a Auth el correo de recuperación, cuyo enlace lleva a
 * /auth/confirm (`type=recovery`) y de ahí a elegir la contraseña. Responde igual exista o
 * no la cuenta, para no revelar qué correos están registrados.
 */
export async function requestPasswordResetAs(supabase: SupabaseClient, email: string): Promise<void> {
  const correo = parseEmail(email);
  const { error } = await supabase.auth.resetPasswordForEmail(correo, { redirectTo: authConfirmUrl() });
  if (!error) return;
  if (error.status === 429) {
    throw new HttpError(429, "Se enviaron demasiados correos; espera unos minutos e intenta de nuevo.");
  }
  throw error;
}

/** Fija la contraseña del usuario de la sesión (tras la recuperación o para cambiarla). */
export async function setPasswordAs(
  supabase: SupabaseClient,
  password: string,
  confirmation: string,
): Promise<void> {
  const { supabase: cliente } = await requireUser(supabase);
  parsePassword(password);
  if (password !== confirmation) throw new HttpError(400, "Las contraseñas no coinciden.");

  const { error } = await cliente.auth.updateUser({ password });
  if (!error) return;
  if (error.code === "same_password") {
    throw new HttpError(400, "La contraseña nueva debe ser distinta de la anterior.");
  }
  if (error.code === "weak_password") {
    throw new HttpError(400, "La contraseña es muy débil: usa letras, números y símbolos.");
  }
  if (error.code === "reauthentication_needed") {
    throw new HttpError(401, "Vuelve a iniciar sesión para cambiar tu contraseña.");
  }
  throw error;
}
