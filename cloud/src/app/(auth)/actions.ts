"use server";

import { redirect } from "next/navigation";
import {
  confirmEmailLinkAs,
  requestPasswordResetAs,
  safeNextPath,
  setPasswordAs,
  signInAs,
} from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions de acceso. Son envoltorios delgados de `@/lib/auth/session`; los
 * formularios las usan con `useActionState`, así que devuelven el error a mostrar.
 */

export interface AuthFormState {
  error: string;
  /** Correo escrito, para no perderlo cuando el envío falla. */
  email?: string;
  /** La acción terminó bien y el formulario muestra su confirmación. */
  done?: boolean;
}

const texto = (valor: FormDataEntryValue | null) => (typeof valor === "string" ? valor : "");

/** Inicia sesión con correo y contraseña y vuelve a la página pedida (`next`) o al inicio. */
export async function signIn(_previo: AuthFormState, datos: FormData): Promise<AuthFormState> {
  const email = texto(datos.get("email"));
  try {
    await signInAs(await createServerSupabase(), email, texto(datos.get("password")));
  } catch (error) {
    if (error instanceof HttpError) return { error: error.message, email };
    throw error;
  }
  redirect(safeNextPath(datos.get("next")));
}

/** Cierra la sesión en este navegador y lleva a /login. */
export async function signOut(): Promise<void> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}

/** Fija la contraseña del usuario de la sesión (tras la recuperación o para cambiarla) y entra. */
export async function setPassword(_previo: AuthFormState, datos: FormData): Promise<AuthFormState> {
  try {
    await setPasswordAs(
      await createServerSupabase(),
      texto(datos.get("password")),
      texto(datos.get("confirmation")),
    );
  } catch (error) {
    if (error instanceof HttpError) return { error: error.message };
    throw error;
  }
  redirect("/");
}

/**
 * "Continuar" en /auth/confirm (POST): usa el token del enlace del correo de recuperación
 * y lleva a elegir la contraseña, o a /login con el aviso si no sirve. El
 * enlace (GET) solo muestra el botón, para que un escáner de correo no gaste el token.
 */
export async function confirmEmailLink(datos: FormData): Promise<void> {
  redirect(
    await confirmEmailLinkAs(await createServerSupabase(), texto(datos.get("token_hash")), texto(datos.get("type"))),
  );
}

/** "¿Olvidaste tu contraseña?": envía el correo de recuperación (responde igual si el correo no tiene cuenta). */
export async function requestPasswordReset(_previo: AuthFormState, datos: FormData): Promise<AuthFormState> {
  const email = texto(datos.get("email"));
  try {
    await requestPasswordResetAs(await createServerSupabase(), email);
  } catch (error) {
    if (error instanceof HttpError) return { error: error.message, email };
    throw error;
  }
  return { error: "", email, done: true };
}
