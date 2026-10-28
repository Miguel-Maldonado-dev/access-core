import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { confirmEmailLink } from "@/app/(auth)/actions";
import ConfirmLinkForm from "@/components/auth/ConfirmLinkForm";
import { INVALID_LINK_MESSAGE, isEmailLinkType } from "@/lib/auth/links";

export const metadata: Metadata = { title: "Continuar" };

/**
 * Enlace del correo de recuperación:
 * `/auth/confirm?token_hash=…&type=recovery` (plantilla en supabase/templates/;
 * ver README). Abrirlo no usa el token: muestra "Continuar", y el POST (`confirmEmailLink`)
 * hace `verifyOtp`, deja la sesión y lleva a elegir la contraseña. Pública: el proxy no la
 * exige con sesión.
 */
export default function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  return (
    <Suspense fallback={null}>
      <Enlace searchParams={searchParams} />
    </Suspense>
  );
}

async function Enlace({ searchParams }: Pick<PageProps<"/auth/confirm">, "searchParams">) {
  const { token_hash: tokenHash, type } = await searchParams;
  if (typeof tokenHash !== "string" || tokenHash === "" || !isEmailLinkType(type)) {
    return (
      <>
        <h1 className="text-2xl font-semibold">El enlace no sirve</h1>
        <p className="mb-6 mt-2 text-muted">{INVALID_LINK_MESSAGE}</p>
        <Link href="/login" className="btn inline-block">
          Ir a iniciar sesión
        </Link>
      </>
    );
  }
  return <ConfirmLinkForm tokenHash={tokenHash} type={type} action={confirmEmailLink} />;
}
