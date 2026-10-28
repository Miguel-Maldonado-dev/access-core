import type { Metadata } from "next";
import ControlsManager from "@/components/access/ControlsManager";
import { guardPage } from "@/lib/auth/guards";
import { listControlsAs } from "@/lib/controls";
import { listHoldersAs } from "@/lib/holders";
import { getInstallationForPage } from "@/lib/installations";
import { createServerSupabase } from "@/lib/supabase/server";
import { deleteControl, saveControl } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Controles" };

/** Pestaña Controles: cada control RF tiene hasta 4 botones con su código y su salida. */
export default async function ControlsPage({ params }: PageProps<"/t/[tenant]/installations/[id]/controles">) {
  const { tenant, id } = await params;
  const supabase = await createServerSupabase();
  const [instalacion, controles, titulares] = await Promise.all([
    getInstallationForPage(tenant, id),
    guardPage(listControlsAs(supabase, tenant, id)),
    guardPage(listHoldersAs(supabase, tenant, id)),
  ]);

  return (
    <ControlsManager
      controls={controles}
      holders={titulares.map((h) => ({ id: h.id, name: h.name }))}
      onSave={saveControl.bind(null, tenant, instalacion.id)}
      onDelete={deleteControl.bind(null, tenant, instalacion.id)}
    />
  );
}
