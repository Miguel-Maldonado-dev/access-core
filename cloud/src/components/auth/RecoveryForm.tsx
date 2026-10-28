"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset, type AuthFormState } from "@/app/(auth)/actions";

const INICIAL: AuthFormState = { error: "" };

/** "¿Olvidaste tu contraseña?": pide el correo de recuperación. */
export default function RecoveryForm() {
  const [estado, accion, enviando] = useActionState(requestPasswordReset, INICIAL);

  return (
    <form action={accion} noValidate className="grid gap-4">
      <label className="block text-sm font-medium">
        Correo
        <input
          className="field text-base"
          type="email"
          name="email"
          defaultValue={estado.email}
          autoComplete="username"
          required
        />
      </label>
      {estado.error !== "" && (
        <p role="alert" className="text-sm font-medium text-danger">
          {estado.error}
        </p>
      )}
      <p role="status" className="notice-ok">
        {estado.done
          ? `Si ${estado.email?.trim().toLowerCase()} tiene cuenta, te enviamos un enlace para elegir una contraseña nueva. Revisa tu correo, también la carpeta de spam.`
          : ""}
      </p>
      <button type="submit" disabled={enviando} className="btn w-full py-2.5">
        {enviando ? "Enviando…" : "Enviar enlace"}
      </button>
      <Link href="/login" className="text-sm font-medium text-signal underline">
        Volver a iniciar sesión
      </Link>
    </form>
  );
}
