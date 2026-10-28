import type { Metadata } from "next";
import { Suspense } from "react";
import LoginForm from "@/components/auth/LoginForm";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/links";

export const metadata: Metadata = { title: "Iniciar sesión" };

/** Inicio de sesión con correo y contraseña (Supabase Auth). Pública: el proxy la deja pasar. */
export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">Iniciar sesión</h1>
      {/* Los parámetros de la URL se leen al pedir la página; el resto se sirve estático. */}
      <Suspense fallback={null}>
        <FormularioConParametros searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function FormularioConParametros({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const { next, error } = await searchParams;
  return (
    <LoginForm
      next={typeof next === "string" ? next : ""}
      notice={error === "enlace" ? INVALID_LINK_MESSAGE : ""}
    />
  );
}
