import AppHeader from "@/components/AppHeader";
import NavLinks from "@/components/NavLinks";
import { guardPage, requireTenantRole } from "@/lib/auth/guards";
import { getViewer } from "@/lib/auth/viewer";
import { ROLE_LABEL } from "@/lib/roles";
import { createServerSupabase } from "@/lib/supabase/server";
import { TENANT_SECTIONS } from "./sections";

export const instant = false;

/**
 * Marco de las páginas de un tenant (`[tenant]` es su id): solo para sus miembros (a los
 * demás, 403). Muestra el nombre del tenant y las pestañas que permite el rol; cada página
 * vuelve a comprobar el suyo.
 */
export default async function TenantLayout({ params, children }: LayoutProps<"/t/[tenant]">) {
  const { tenant } = await params;
  const [viewer, acceso] = await Promise.all([
    getViewer(),
    guardPage(requireTenantRole(tenant, "tecnico", await createServerSupabase())),
  ]);
  const { data, error } = await acceso.supabase
    .from("tenants")
    .select("name")
    .eq("id", tenant)
    .single<{ name: string }>();
  if (error) throw error;

  const secciones = TENANT_SECTIONS.filter((s) => s.minRole === "tecnico" || acceso.role === "admin").map(
    (s) => ({ href: `/t/${tenant}/${s.segment}`, label: s.label }),
  );

  return (
    <>
      <AppHeader viewer={viewer} />
      <div className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <p className="flex flex-wrap items-baseline gap-x-3 pt-4 pb-2">
            <span className="text-xl font-semibold">{data.name}</span>
            <span className="text-sm text-muted">{ROLE_LABEL[acceso.role]}</span>
          </p>
          <NavLinks items={secciones} label="Secciones del tenant" variant="tabs" />
        </div>
      </div>
      <main className="mx-auto max-w-6xl px-4 py-6 md:px-6">{children}</main>
    </>
  );
}
