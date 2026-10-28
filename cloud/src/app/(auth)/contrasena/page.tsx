import type { Metadata } from "next";
import PasswordForm from "@/components/auth/PasswordForm";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Elige tu contraseña" };

/**
 * A esta página llega quien recupera su contraseña desde /auth/confirm, ya con sesión; también
 * sirve para cambiarla. El proxy lleva a /login a quien no la tenga y la acción vuelve a
 * comprobar la sesión.
 */
export default function SetPasswordPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Elige tu contraseña</h1>
      <p className="mb-6 mt-2 text-muted">Con ella y tu correo entrarás a partir de ahora.</p>
      <PasswordForm minLength={MIN_PASSWORD_LENGTH} />
    </>
  );
}
