import type { Metadata } from "next";
import TenantsAdmin from "@/components/tenants/TenantsAdmin";
import { guardPage } from "@/lib/auth/guards";
import { listTenantsAs } from "@/lib/tenants/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { addTenantAdmin, createTenant, setTenantSuspended } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Tenants" };

/** Tenants de la plataforma (solo súper administrador; a los demás, 403). */
export default async function TenantsPage() {
  const tenants = await guardPage(listTenantsAs(await createServerSupabase()));
  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold">Tenants</h1>
      <TenantsAdmin
        tenants={tenants}
        onCreate={createTenant}
        onSetSuspended={setTenantSuspended}
        onAddAdmin={addTenantAdmin}
      />
    </div>
  );
}
