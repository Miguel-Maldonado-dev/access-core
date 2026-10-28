"use client";

import { useActionState } from "react";
import { setPassword, type AuthFormState } from "@/app/(auth)/actions";

const INICIAL: AuthFormState = { error: "" };

/** Formulario para elegir la contraseña (tras la recuperación o para cambiarla). */
export default function PasswordForm({ minLength }: { minLength: number }) {
  const [estado, accion, enviando] = useActionState(setPassword, INICIAL);

  return (
    <form action={accion} noValidate className="grid gap-4">
      <label className="block text-sm font-medium">
        Contraseña nueva
        <input
          className="field text-base"
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={minLength}
          aria-describedby="contrasena-ayuda"
          required
        />
      </label>
      <p id="contrasena-ayuda" className="-mt-2 text-sm text-muted">
        Al menos {minLength} caracteres.
      </p>
      <label className="block text-sm font-medium">
        Repite la contraseña
        <input
          className="field text-base"
          type="password"
          name="confirmation"
          autoComplete="new-password"
          required
        />
      </label>
      {estado.error !== "" && (
        <p role="alert" className="text-sm font-medium text-danger">
          {estado.error}
        </p>
      )}
      <button type="submit" disabled={enviando} className="btn mt-2 w-full py-2.5">
        {enviando ? "Guardando…" : "Guardar y entrar"}
      </button>
    </form>
  );
}
