import type { Metadata } from "next";
import RecoveryForm from "@/components/auth/RecoveryForm";

export const metadata: Metadata = { title: "Recuperar contraseña" };

/** "¿Olvidaste tu contraseña?" (pública: el proxy deja pasar /auth/*). */
export default function RecoverPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">¿Olvidaste tu contraseña?</h1>
      <p className="mb-6 mt-2 text-muted">
        Escribe tu correo y te enviaremos un enlace para elegir una contraseña nueva.
      </p>
      <RecoveryForm />
    </>
  );
}
