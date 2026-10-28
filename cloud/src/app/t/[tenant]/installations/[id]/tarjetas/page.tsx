import type { Metadata } from "next";
import CardsManager from "@/components/access/CardsManager";
import { guardPage } from "@/lib/auth/guards";
import { listCardsAs } from "@/lib/cards";
import { listHoldersAs } from "@/lib/holders";
import { getInstallationForPage } from "@/lib/installations";
import { createServerSupabase } from "@/lib/supabase/server";
import { deleteCard, saveCard } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Tarjetas" };

/** Pestaña Tarjetas: códigos en decimal, cada una de un titular. */
export default async function CardsPage({ params }: PageProps<"/t/[tenant]/installations/[id]/tarjetas">) {
  const { tenant, id } = await params;
  const supabase = await createServerSupabase();
  const [instalacion, tarjetas, titulares] = await Promise.all([
    getInstallationForPage(tenant, id),
    guardPage(listCardsAs(supabase, tenant, id)),
    guardPage(listHoldersAs(supabase, tenant, id)),
  ]);

  return (
    <CardsManager
      cards={tarjetas}
      holders={titulares.map((h) => ({ id: h.id, name: h.name }))}
      onSave={saveCard.bind(null, tenant, instalacion.id)}
      onDelete={deleteCard.bind(null, tenant, instalacion.id)}
    />
  );
}
