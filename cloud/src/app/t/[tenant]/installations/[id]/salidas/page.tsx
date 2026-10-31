import type { Metadata } from "next";
import OutputsManager from "@/components/access/OutputsManager";
import { guardPage } from "@/lib/auth/guards";
import { getInstallationForPage } from "@/lib/installations";
import { listOutputsAs } from "@/lib/outputs";
import { listPanelsAs } from "@/lib/panels/list";
import { isLinkedPanel } from "@/lib/profile-view";
import { createServerSupabase } from "@/lib/supabase/server";
import { commandStatus, saveOutput, testOutput } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Salidas" };

/** Pestaña Salidas: las 4 salidas de cada panel con su alias, duración, lectores y estado, y "Probar". */
export default async function OutputsPage({ params }: PageProps<"/t/[tenant]/installations/[id]/salidas">) {
  const { tenant, id } = await params;
  const supabase = await createServerSupabase();
  const [instalacion, salidas, paneles] = await Promise.all([
    getInstallationForPage(tenant, id),
    guardPage(listOutputsAs(supabase, tenant, id)),
    guardPage(listPanelsAs(supabase, id)),
  ]);

  return (
    <OutputsManager
      panels={paneles.filter(isLinkedPanel).map((p) => ({ id: p.id, panel_code: p.panel_code }))}
      outputs={salidas}
      onSave={saveOutput.bind(null, tenant, instalacion.id)}
      onTest={testOutput.bind(null, tenant, instalacion.id)}
      onStatus={commandStatus.bind(null, tenant, instalacion.id)}
    />
  );
}
