import type { Metadata } from "next";
import HoldersManager from "@/components/access/HoldersManager";
import { guardPage, requireTenantRole } from "@/lib/auth/guards";
import { getInstallationForPage } from "@/lib/installations";
import { listHoldersAs } from "@/lib/holders";
import { createServerSupabase } from "@/lib/supabase/server";
import { deleteHolder, revealHolderPin, saveHolder } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Titulares" };

/** Pestaña Titulares: cualquier miembro edita; solo el `admin` puede ver el PIN actual al editar. */
export default async function HoldersPage({ params }: PageProps<"/t/[tenant]/installations/[id]/titulares">) {
  const { tenant, id } = await params;
  const supabase = await createServerSupabase();
  const [acceso, instalacion, titulares] = await Promise.all([
    guardPage(requireTenantRole(tenant, "tecnico", supabase)),
    getInstallationForPage(tenant, id),
    guardPage(listHoldersAs(supabase, tenant, id)),
  ]);

  return (
    <HoldersManager
      holders={titulares}
      canSeePin={acceso.role === "admin"}
      onSave={saveHolder.bind(null, tenant, instalacion.id)}
      onDelete={deleteHolder.bind(null, tenant, instalacion.id)}
      onRevealPin={revealHolderPin.bind(null, tenant, instalacion.id)}
    />
  );
}
