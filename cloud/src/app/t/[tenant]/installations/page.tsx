import type { Metadata } from "next";
import InstallationsManager from "@/components/installations/InstallationsManager";
import { guardPage, requireTenantRole } from "@/lib/auth/guards";
import { listInstallationsAs } from "@/lib/installations";
import { createServerSupabase } from "@/lib/supabase/server";
import { createInstallation, renameInstallation } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Instalaciones" };

/** Instalaciones del tenant: las ve cualquier miembro; solo su `admin` crea. */
export default async function InstallationsPage({ params }: PageProps<"/t/[tenant]/installations">) {
  const { tenant } = await params;
  const supabase = await createServerSupabase();
  const [acceso, instalaciones] = await Promise.all([
    guardPage(requireTenantRole(tenant, "tecnico", supabase)),
    guardPage(listInstallationsAs(supabase, tenant)),
  ]);

  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold">Instalaciones</h1>
      <InstallationsManager
        tenantId={tenant}
        installations={instalaciones}
        canCreate={acceso.role === "admin"}
        onCreate={createInstallation}
        onRename={renameInstallation}
      />
    </div>
  );
}
