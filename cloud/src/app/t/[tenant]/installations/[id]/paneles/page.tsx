import type { Metadata } from "next";
import DeleteInstallationButton from "@/components/installations/DeleteInstallationButton";
import PanelsManager from "@/components/panels/PanelsManager";
import { guardPage, requireTenantRole } from "@/lib/auth/guards";
import { getInstallationForPage } from "@/lib/installations";
import { listPanelsAs } from "@/lib/panels/list";
import { createServerSupabase } from "@/lib/supabase/server";
import { deleteInstallation } from "../../actions";
import { claimPanel, confirmDeletions, revokePanel } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Paneles" };

/**
 * Pestaña Paneles: lectura para todo miembro; vincular, revocar, confirmar borrados y eliminar la
 * instalación (zona de peligro), solo `admin`.
 */
export default async function PanelsPage({
  params,
  searchParams,
}: PageProps<"/t/[tenant]/installations/[id]/paneles">) {
  const [{ tenant, id }, consulta] = await Promise.all([params, searchParams]);
  const supabase = await createServerSupabase();
  const [acceso, instalacion, paneles] = await Promise.all([
    guardPage(requireTenantRole(tenant, "tecnico", supabase)),
    getInstallationForPage(tenant, id),
    guardPage(listPanelsAs(supabase, tenant, id, { incluirRevocados: true })),
  ]);

  const esAdmin = acceso.role === "admin";
  const eliminar = deleteInstallation.bind(null, tenant, instalacion.id);

  return (
    <div className="grid grid-cols-1 gap-8">
      <PanelsManager
        installationId={instalacion.id}
        basePath={`/t/${tenant}/installations/${id}/paneles`}
        installationRevision={instalacion.revision}
        panels={paneles}
        canAdmin={esAdmin}
        initialNotice={
          consulta.aviso === "sin-importacion"
            ? {
                kind: "error",
                text: "Esa importación ya no estaba pendiente: otro administrador la resolvió.",
              }
            : null
        }
        onClaim={claimPanel}
        onRevoke={revokePanel}
        onConfirmDeletions={confirmDeletions}
      />
      <DeleteInstallationButton
        canDelete={esAdmin}
        installationName={instalacion.name}
        listPath={`/t/${tenant}/installations`}
        onDelete={eliminar}
      />
    </div>
  );
}
