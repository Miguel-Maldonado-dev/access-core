import Link from "next/link";
import BrandMark from "@/components/BrandMark";

/** Página 403: la muestra `forbidden()` (guardPage) a quien tiene sesión pero no el rol. */
export default function Forbidden() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="panel w-full max-w-md">
        <span className="inline-block rounded bg-ink p-1.5">
          <BrandMark size={22} />
        </span>
        <h1 className="mt-4 text-2xl font-semibold">No tienes acceso a esta página</h1>
        <p className="mt-2 text-muted">
          Tu cuenta no tiene el permiso que pide. Si crees que debería tenerlo, pide a un
          administrador de tu tenant que revise tu rol.
        </p>
        <Link href="/" className="btn mt-6 inline-block">
          Ir al inicio
        </Link>
      </div>
    </main>
  );
}
