"use client";

import { useFormStatus } from "react-dom";
import type { EmailLinkType } from "@/lib/auth/links";

const TEXTOS: Record<EmailLinkType, { titulo: string; detalle: string }> = {
  recovery: {
    titulo: "Restablece tu contraseña",
    detalle: "Pulsa Continuar para elegir una contraseña nueva.",
  },
};

/**
 * /auth/confirm: el enlace del correo solo muestra este botón; el token se usa al enviarlo
 * (POST, `action`), así un escáner de correo que abre el enlace no lo gasta.
 */
export default function ConfirmLinkForm({
  tokenHash,
  type,
  action,
}: {
  tokenHash: string;
  type: EmailLinkType;
  action: (datos: FormData) => void | Promise<void>;
}) {
  const texto = TEXTOS[type];
  return (
    <>
      <h1 className="text-2xl font-semibold">{texto.titulo}</h1>
      <p className="mb-6 mt-2 text-muted">{texto.detalle}</p>
      <form action={action}>
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        <BotonContinuar />
      </form>
    </>
  );
}

function BotonContinuar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn w-full py-2.5">
      Continuar
    </button>
  );
}
