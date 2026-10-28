import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import ImportReview from "@/components/panels/ImportReview";
import { guardPage, requireTenantRole } from "@/lib/auth/guards";
import { readImportDiffAs } from "@/lib/device/imports";
import { HttpError } from "@/lib/errors";
import { getInstallationForPage } from "@/lib/installations";
import { createServerSupabase } from "@/lib/supabase/server";
import { confirmImport } from "../../actions";

export const instant = false;
export const metadata: Metadata = { title: "Revisar importación" };

/** Revisión de la importación de un panel en `awaiting_review` (lectura para todo miembro). */
export default async function ImportPage({
  params,
}: PageProps<"/t/[tenant]/installations/[id]/paneles/[panelId]/importacion">) {
  const { tenant, id, panelId } = await params;
  if (!z.guid().safeParse(panelId).success) notFound();
  const supabase = await createServerSupabase();
  const [acceso, instalacion, panel] = await Promise.all([
    guardPage(requireTenantRole(tenant, "tecnico", supabase)),
    getInstallationForPage(tenant, id),
    // RLS: el panel solo se ve si es de un tenant del que el usuario es miembro.
    supabase
      .from("panels")
      .select("id, panel_code")
      .eq("id", panelId)
      .eq("installation_id", id)
      .maybeSingle<{ id: string; panel_code: string }>(),
  ]);
  if (panel.error) throw panel.error;
  if (!panel.data) notFound();

  let diff;
  try {
    diff = await readImportDiffAs(supabase, panel.data.id);
  } catch (error) {
    // El panel es visible, así que un 404 es que ya no hay importación pendiente (otro
    // administrador la resolvió): se vuelve a Paneles con el aviso.
    if (error instanceof HttpError && error.status === 404) {
      redirect(`/t/${tenant}/installations/${instalacion.id}/paneles?aviso=sin-importacion`);
    }
    throw error;
  }

  return (
    <ImportReview
      panelId={panel.data.id}
      panelCode={panel.data.panel_code}
      backHref={`/t/${tenant}/installations/${instalacion.id}/paneles`}
      diff={diff}
      canImport={acceso.role === "admin"}
      onConfirm={confirmImport}
    />
  );
}
