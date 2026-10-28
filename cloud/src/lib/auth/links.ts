import "server-only";

/**
 * Enlace del correo de recuperación de Auth. La plantilla (supabase/templates/) arma
 * `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=<tipo>`, y `RedirectTo` es esta URL,
 * que debe estar entre las Redirect URLs de Supabase (ver README).
 */
export function authConfirmUrl(): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    throw new Error("Falta APP_URL en el entorno del servidor: el enlace del correo de recuperación la usa.");
  }
  return `${appUrl.replace(/\/+$/, "")}/auth/confirm`;
}

/** Tipos de enlace que acepta /auth/confirm. */
export const EMAIL_LINK_TYPES = ["recovery"] as const;
export type EmailLinkType = (typeof EMAIL_LINK_TYPES)[number];

export function isEmailLinkType(valor: unknown): valor is EmailLinkType {
  return EMAIL_LINK_TYPES.includes(valor as EmailLinkType);
}

/** Aviso cuando el enlace de un correo no sirve (en /login y en /auth/confirm). */
export const INVALID_LINK_MESSAGE =
  "El enlace no es válido, ya se usó o venció. Usa «¿Olvidaste tu contraseña?» para pedir otro.";
