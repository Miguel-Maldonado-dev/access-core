import type { Metadata } from "next";
import ControlsManager from "@/components/access/ControlsManager";
import { OUTPUT_COUNT } from "@/lib/access-view";
import { guardPage } from "@/lib/auth/guards";
import { listControlsAs } from "@/lib/controls";
import { listHoldersAs } from "@/lib/holders";
import { getInstallationForPage } from "@/lib/installations";
import { listOutputsAs } from "@/lib/outputs";
import { listPanelsAs } from "@/lib/panels/list";
import { isLinkedPanel } from "@/lib/profile-view";
import { createServerSupabase } from "@/lib/supabase/server";
import { deleteControl, saveControl } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Controles" };

/** Pestaña Controles: cada botón de un control RF tiene su código y su salida en cada panel vinculado. */
export default async function ControlsPage({ params }: PageProps<"/t/[tenant]/installations/[id]/controles">) {
  const { tenant, id } = await params;
  const supabase = await createServerSupabase();
  const [instalacion, controles, titulares, paneles, salidas] = await Promise.all([
    getInstallationForPage(tenant, id),
    guardPage(listControlsAs(supabase, tenant, id)),
    guardPage(listHoldersAs(supabase, tenant, id)),
    guardPage(listPanelsAs(supabase, id)),
    guardPage(listOutputsAs(supabase, tenant, id)),
  ]);
  const alias = new Map(salidas.map((o) => [`${o.panel_id}:${o.output_index}`, o.alias.trim() || null]));
  const panels = paneles.filter(isLinkedPanel).map((p) => ({
    id: p.id,
    panel_code: p.panel_code,
    aliases: Array.from({ length: OUTPUT_COUNT }, (_, i) => alias.get(`${p.id}:${i}`) ?? null),
  }));

  return (
    <ControlsManager
      controls={controles}
      holders={titulares.map((h) => ({ id: h.id, name: h.name }))}
      panels={panels}
      onSave={saveControl.bind(null, tenant, instalacion.id)}
      onDelete={deleteControl.bind(null, tenant, instalacion.id)}
    />
  );
}
