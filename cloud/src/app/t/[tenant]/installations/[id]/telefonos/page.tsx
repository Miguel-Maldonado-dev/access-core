import type { Metadata } from "next";
import PhonesManager from "@/components/access/PhonesManager";
import { guardPage } from "@/lib/auth/guards";
import { listHoldersAs } from "@/lib/holders";
import { getInstallationForPage } from "@/lib/installations";
import { listPhonesAs } from "@/lib/phones";
import { createServerSupabase } from "@/lib/supabase/server";
import { deletePhone, savePhone } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Teléfonos" };

/** Pestaña Teléfonos: números de 10 dígitos, cada uno de un titular. `?holder=` filtra por titular. */
export default async function PhonesPage({
  params,
  searchParams,
}: PageProps<"/t/[tenant]/installations/[id]/telefonos">) {
  const { tenant, id } = await params;
  const consulta = await searchParams;
  const titular = Array.isArray(consulta.holder) ? consulta.holder[0] : consulta.holder;
  const supabase = await createServerSupabase();
  const [instalacion, telefonos, titulares] = await Promise.all([
    getInstallationForPage(tenant, id),
    guardPage(listPhonesAs(supabase, tenant, id)),
    guardPage(listHoldersAs(supabase, tenant, id)),
  ]);

  return (
    <PhonesManager
      phones={telefonos}
      holders={titulares.map((h) => ({ id: h.id, name: h.name }))}
      initialHolder={titular ?? ""}
      onSave={savePhone.bind(null, tenant, instalacion.id)}
      onDelete={deletePhone.bind(null, tenant, instalacion.id)}
    />
  );
}
