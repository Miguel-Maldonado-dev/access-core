import type { Metadata } from "next";
import ConflictsManager from "@/components/conflicts/ConflictsManager";
import Pagination from "@/components/Pagination";
import { guardPage } from "@/lib/auth/guards";
import { listConflictsAs } from "@/lib/conflicts";
import { getInstallationForPage } from "@/lib/installations";
import { parseLogFilters } from "@/lib/log-view";
import { createServerSupabase } from "@/lib/supabase/server";
import { markConflictReviewed } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Conflictos" };

/** Pestaña Conflictos: admin y técnico los ven y los marcan como revisados; 50 por página. */
export default async function ConflictsPage({
  params,
  searchParams,
}: PageProps<"/t/[tenant]/installations/[id]/conflictos">) {
  const [{ tenant, id }, consulta] = await Promise.all([params, searchParams]);
  const supabase = await createServerSupabase();
  const [instalacion, pagina] = await Promise.all([
    getInstallationForPage(tenant, id),
    guardPage(listConflictsAs(supabase, tenant, id, parseLogFilters({ pagina: consulta.pagina }).page)),
  ]);
  const base = `/t/${tenant}/installations/${id}/conflictos`;

  return (
    <div className="grid grid-cols-1 gap-4">
      <h2 className="text-lg font-semibold">Conflictos de sincronización</h2>
      <ConflictsManager rows={pagina.rows} onReview={markConflictReviewed.bind(null, tenant, instalacion.id)} />
      <Pagination
        page={pagina.page}
        pageSize={pagina.pageSize}
        total={pagina.total}
        hrefFor={(p) => (p > 1 ? `${base}?pagina=${p}` : base)}
      />
    </div>
  );
}
