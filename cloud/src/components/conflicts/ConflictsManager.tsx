"use client";

import { useState, useTransition } from "react";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import { CONFLICT_KIND_LABEL, type ConflictRow } from "@/lib/conflict-view";
import { formatDateTime } from "@/lib/log-view";
import { TABLE_LABEL } from "@/lib/panels/view";

interface Props {
  rows: ConflictRow[];
  onReview: (conflictId: number) => Promise<ActionResult>;
}

const HEADERS = ["Tipo", "Tabla", "Panel", "Fecha", "Resolución", "Estado"];

/** Pestaña Conflictos: lista y "Marcar como revisado" (el revisado sigue en la lista, con su fecha). */
export default function ConflictsManager({ rows, onReview }: Props) {
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();

  function revisar(c: ConflictRow) {
    setNotice(null);
    startTransition(async () => {
      const r = await onReview(c.id);
      setNotice(
        r.ok
          ? { kind: "ok", text: `Conflicto de ${TABLE_LABEL[c.table_name] ?? c.table_name} de ${c.panel_code} marcado como revisado.` }
          : { kind: "error", text: r.error },
      );
    });
  }

  return (
    <div className="grid grid-cols-1 gap-3">
      <Notices notice={notice} />
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-paper text-muted">
            <tr>
              {HEADERS.map((h) => (
                <th key={h} scope="col" className="whitespace-nowrap px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="whitespace-nowrap px-4 py-2">{CONFLICT_KIND_LABEL[c.kind]}</td>
                <td className="whitespace-nowrap px-4 py-2">{TABLE_LABEL[c.table_name] ?? c.table_name}</td>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{c.panel_code}</td>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDateTime(c.created_at)}</td>
                <td className="px-4 py-2">{c.resolution}</td>
                <td className="whitespace-nowrap px-4 py-2">
                  {c.reviewed_at ? (
                    <span className="text-muted">Revisado el {formatDateTime(c.reviewed_at)}</span>
                  ) : (
                    <button type="button" className="link-action" disabled={pendiente} onClick={() => revisar(c)}>
                      Marcar como revisado
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={HEADERS.length} className="px-4 py-6 text-center text-muted">
                  No hay conflictos de sincronización.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
