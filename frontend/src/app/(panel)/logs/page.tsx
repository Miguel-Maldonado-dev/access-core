"use client";

import { useEffect, useState } from "react";
import LogFilters from "@/components/LogFilters";
import LogTable from "@/components/LogTable";
import { apiFetch } from "@/lib/api";
import { buildLogQuery, type LogFilterState } from "@/lib/logQuery";
import { errorMessage, useApiResource } from "@/lib/useApiList";
import type { Holder, LogPage } from "@/lib/types";

const PAGE_SIZE = 50;
const EMPTY_PAGE: LogPage = { items: [], total: 0, page: 1, page_size: PAGE_SIZE };

export default function LogsPage() {
  const [holders, setHolders] = useState<Holder[]>([]);
  const [filters, setFilters] = useState<LogFilterState>({});
  const [page, setPage] = useState(1);
  const { data, error, setError, loaded, reload } = useApiResource<LogPage>(
    `/api/logs?${buildLogQuery(filters, page, PAGE_SIZE)}`,
    EMPTY_PAGE,
  );

  useEffect(() => {
    apiFetch<Holder[]>("/api/holders").then(setHolders, (err) => setError(errorMessage(err)));
  }, [setError]);

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  function changeFilters(next: LogFilterState) {
    setFilters(next);
    setPage(1);
  }

  async function clearLogs() {
    if (!confirm("¿Borrar todos los logs? Esta acción no se puede deshacer.")) return;
    try {
      await apiFetch("/api/logs", { method: "DELETE" });
      setError("");
      setPage(1);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Logs</h1>
        <div className="flex gap-3">
          <button type="button" className="btn-quiet" onClick={reload}>
            Actualizar
          </button>
          <button type="button" className="btn-quiet text-danger" onClick={() => void clearLogs()}>
            Borrar logs
          </button>
        </div>
      </div>

      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      <LogFilters value={filters} holders={holders} onChange={changeFilters} />

      <LogTable items={loaded ? data.items : []} />

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-muted">
          Página {page} de {pages}
        </span>
        <div className="flex gap-3">
          <button type="button" className="btn-quiet" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Anterior
          </button>
          <button type="button" className="btn-quiet" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Siguiente
          </button>
        </div>
      </div>
    </div>
  );
}
