import type { Metadata } from "next";
import QrCodesManager from "@/components/access/QrCodesManager";
import QrSettingsForm from "@/components/access/QrSettingsForm";
import { guardPage, requireTenantRole } from "@/lib/auth/guards";
import { listHoldersAs } from "@/lib/holders";
import { getInstallationForPage, getQrSettingsAs } from "@/lib/installations";
import { listQrCodesAs } from "@/lib/qr-codes";
import { createServerSupabase } from "@/lib/supabase/server";
import { createQrCode, deleteQrCode, saveQrSettings } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "QR" };

/** Pestaña QR: accesos temporales de un anfitrión y, abajo, los ajustes de QR (edita el admin). */
export default async function QrPage({ params }: PageProps<"/t/[tenant]/installations/[id]/qr">) {
  const { tenant, id } = await params;
  const supabase = await createServerSupabase();
  const [acceso, instalacion, codigos, titulares, ajustes] = await Promise.all([
    guardPage(requireTenantRole(tenant, "tecnico", supabase)),
    getInstallationForPage(tenant, id),
    guardPage(listQrCodesAs(supabase, tenant, id)),
    guardPage(listHoldersAs(supabase, tenant, id)),
    guardPage(getQrSettingsAs(supabase, tenant, id)),
  ]);

  return (
    <div className="grid grid-cols-1 gap-10">
      <QrCodesManager
        codes={codigos}
        holders={titulares.map((h) => ({ id: h.id, name: h.name }))}
        onCreate={createQrCode.bind(null, tenant, instalacion.id)}
        onDelete={deleteQrCode.bind(null, tenant, instalacion.id)}
      />
      <QrSettingsForm
        settings={ajustes}
        canEdit={acceso.role === "admin"}
        onSave={saveQrSettings.bind(null, tenant, instalacion.id)}
      />
    </div>
  );
}
