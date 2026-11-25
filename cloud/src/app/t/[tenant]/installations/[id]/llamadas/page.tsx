import type { Metadata } from "next";
import CallSettingsManager from "@/components/access/CallSettingsManager";
import { guardPage, requireTenantRole } from "@/lib/auth/guards";
import { listCallSettingsAs } from "@/lib/call-settings";
import { getInstallationForPage } from "@/lib/installations";
import { listOutputsAs } from "@/lib/outputs";
import { listPanelsAs } from "@/lib/panels/list";
import { isLinkedPanel } from "@/lib/profile-view";
import { createServerSupabase } from "@/lib/supabase/server";
import { saveCallSettings } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Llamadas" };

/** Pestaña Llamadas: apertura por llamada de cada panel. Edita el admin; el técnico la ve en solo lectura. */
export default async function CallSettingsPage({ params }: PageProps<"/t/[tenant]/installations/[id]/llamadas">) {
  const { tenant, id } = await params;
  const supabase = await createServerSupabase();
  const [acceso, instalacion, ajustes, salidas, paneles] = await Promise.all([
    guardPage(requireTenantRole(tenant, "tecnico", supabase)),
    getInstallationForPage(tenant, id),
    guardPage(listCallSettingsAs(supabase, tenant, id)),
    guardPage(listOutputsAs(supabase, tenant, id)),
    guardPage(listPanelsAs(supabase, tenant, id)),
  ]);

  return (
    <CallSettingsManager
      panels={paneles.filter(isLinkedPanel).map((p) => ({ id: p.id, panel_code: p.panel_code }))}
      settings={ajustes}
      outputs={salidas}
      canEdit={acceso.role === "admin"}
      onSave={saveCallSettings.bind(null, tenant, instalacion.id)}
    />
  );
}
