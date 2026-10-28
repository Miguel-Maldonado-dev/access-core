import type { Metadata } from "next";
import PanelsManager from "@/components/panels/PanelsManager";
import { guardPage, requireTenantRole } from "@/lib/auth/guards";
import { getInstallationForPage } from "@/lib/installations";
import { listPanelsAs } from "@/lib/panels/list";
import { createServerSupabase } from "@/lib/supabase/server";
import { claimPanel, confirmDeletions, revokePanel } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Paneles" };

/** Pestaña Paneles: lectura para todo miembro; vincular, revocar y confirmar borrados, solo `admin`. */
export default async function PanelsPage({ params, searchParams }: PageProps<"/t/[tenant]/installations/[id]/paneles">) {
  const [{ tenant, id }, consulta] = await Promise.all([params, searchParams]);
  const supabase = await createServerSupabase();
  const [acceso, instalacion, paneles] = await Promise.all([
    guardPage(requireTenantRole(tenant, "tecnico", supabase)),
    getInstallationForPage(tenant, id),
    guardPage(listPanelsAs(supabase, id)),
  ]);

  return (
    <PanelsManager
      installationId={instalacion.id}
      basePath={`/t/${tenant}/installations/${id}/paneles`}
      installationRevision={instalacion.revision}
      panels={paneles}
      canAdmin={acceso.role === "admin"}
      initialNotice={
        consulta.aviso === "sin-importacion"
          ? { kind: "error", text: "Esa importación ya no estaba pendiente: otro administrador la resolvió." }
          : null
      }
      onClaim={claimPanel}
      onRevoke={revokePanel}
      onConfirmDeletions={confirmDeletions}
    />
  );
}
