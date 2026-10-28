"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn, type AuthFormState } from "@/app/(auth)/actions";

const INICIAL: AuthFormState = { error: "" };

/** Formulario de inicio de sesión. `next`: ruta a la que volver; `notice`: aviso previo (enlace inválido). */
export default function LoginForm({ next, notice }: { next: string; notice: string }) {
  const [estado, accion, enviando] = useActionState(signIn, INICIAL);

  return (
    <form action={accion} noValidate className="grid gap-4">
      {notice !== "" && <p className="notice-error">{notice}</p>}
      <input type="hidden" name="next" value={next} />
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
      <label className="block text-sm font-medium">
        Contraseña
        <input
          className="field text-base"
          type="password"
          name="password"
          autoComplete="current-password"
          required
        />
      </label>
      {estado.error !== "" && (
        <p role="alert" className="text-sm font-medium text-danger">
          {estado.error}
        </p>
      )}
      <button type="submit" disabled={enviando} className="btn mt-2 w-full py-2.5">
        {enviando ? "Entrando…" : "Entrar"}
      </button>
      <Link href="/auth/recuperar" className="text-sm font-medium text-signal underline">
        ¿Olvidaste tu contraseña?
      </Link>
    </form>
  );
}
