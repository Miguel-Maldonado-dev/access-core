import type { Metadata } from "next";
import LogFilters from "@/components/logs/LogFilters";
import LogTable from "@/components/logs/LogTable";
import RefreshLogsButton from "@/components/logs/RefreshLogsButton";
import Pagination from "@/components/Pagination";
import { guardPage } from "@/lib/auth/guards";
import { getInstallationForPage } from "@/lib/installations";
import { logsHref, parseLogFilters } from "@/lib/log-view";
import { listLogFilterOptionsAs, listLogsAs } from "@/lib/logs";
import { createServerSupabase } from "@/lib/supabase/server";
import { logsUploadStatus, requestLogsUpload } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Logs" };

/**
 * Pestaña Logs: filtros en la URL (compartible), 50 por página, del más reciente al más
 * viejo; "Actualizar logs" pide a los paneles en línea lo que aún no han subido.
 */
export default async function LogsPage({ params, searchParams }: PageProps<"/t/[tenant]/installations/[id]/logs">) {
  const [{ tenant, id }, consulta] = await Promise.all([params, searchParams]);
  const filtros = parseLogFilters(consulta);
  const supabase = await createServerSupabase();
  const [instalacion, opciones, pagina] = await Promise.all([
    getInstallationForPage(tenant, id),
    guardPage(listLogFilterOptionsAs(supabase, tenant, id)),
    guardPage(listLogsAs(supabase, tenant, id, filtros)),
  ]);
  const base = `/t/${tenant}/installations/${id}/logs`;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">Logs de acceso</h2>
        <RefreshLogsButton
          onRequest={requestLogsUpload.bind(null, tenant, instalacion.id)}
          onStatus={logsUploadStatus.bind(null, tenant, instalacion.id)}
        />
      </div>
      <LogFilters action={base} filters={filtros} panels={opciones.panels} holders={opciones.holders} />
      <LogTable rows={pagina.rows} />
      <Pagination
        page={pagina.page}
        pageSize={pagina.pageSize}
        total={pagina.total}
        hrefFor={(p) => logsHref(base, filtros, p)}
      />
    </div>
  );
}
