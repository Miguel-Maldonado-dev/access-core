import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import { guardPage } from "@/lib/auth/guards";
import { getViewer } from "@/lib/auth/viewer";
import { ROLE_LABEL } from "@/lib/roles";
import { listMyTenantsAs } from "@/lib/tenants/members";
import { createServerSupabase } from "@/lib/supabase/server";

// Lee la sesión antes de renderizar, sin <Suspense>: con Cache Components esta opción
// permite esa espera (sin ella la compilación falla). Igual en todas las páginas con sesión.
export const instant = false;

/** Inicio tras el login: los tenants del usuario y, al súper administrador, la administración de tenants. */
export default async function HomePage() {
  const [viewer, tenants] = await Promise.all([
    getViewer(),
    guardPage(listMyTenantsAs(await createServerSupabase())),
  ]);

  return (
    <>
      <AppHeader viewer={viewer} />
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 md:px-6">
        <h1 className="text-2xl font-semibold">Tus tenants</h1>

        {viewer.isPlatformAdmin && (
          <section
            aria-label="Súper administrador"
            className="panel flex flex-wrap items-center justify-between gap-4"
          >
            <p className="max-w-prose">
              Eres súper administrador: das de alta los tenants, los suspendes y creas las cuentas de sus administradores.
            </p>
            <Link href="/admin/tenants" className="btn">
              Administrar tenants
            </Link>
          </section>
        )}

        {tenants.length === 0 ? (
          <p className="text-muted">
            Aún no perteneces a ningún tenant. Pide a su administrador que te dé de alta con este correo.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-paper text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Tenant</th>
                  <th scope="col" className="px-4 py-2 font-medium">Tu rol</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      {t.suspended ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{t.name}</span>
                          <span className="tag text-warn">Suspendido</span>
                        </span>
                      ) : (
                        <Link href={`/t/${t.id}/installations`} className="link-action text-base">
                          {t.name}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3">{ROLE_LABEL[t.role]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
