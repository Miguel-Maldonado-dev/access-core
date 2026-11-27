"use client";

import { useState, useTransition } from "react";
import QrCodeForm from "@/components/access/QrCodeForm";
import QrImage from "@/components/access/QrImage";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import { formatDateTime } from "@/lib/log-view";
import type { QrCodeInput, QrCodeRow } from "@/lib/qr-codes";
import { QR_STATUS_LABELS } from "@/lib/qr-view";

interface Props {
  codes: QrCodeRow[];
  holders: { id: string; name: string }[];
  onCreate: (input: QrCodeInput) => Promise<ActionResult<{ id: string }>>;
  onDelete: (qrId: string) => Promise<ActionResult>;
}

type Estado = "" | QrCodeRow["status"];

/** Pestaña QR: accesos temporales de un anfitrión. Se crean y se revocan; no se editan. */
export default function QrCodesManager({ codes, holders, onCreate, onDelete }: Props) {
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<Estado>("");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<QrCodeRow | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [pendiente, startTransition] = useTransition();

  const visibles = codes.filter((c) => (filter === "" || c.holder_id === filter) && (status === "" || c.status === status));

  function abrirAlta() {
    setNotice(null);
    setFormError("");
    setCreating(true);
  }

  function crear(input: QrCodeInput) {
    setFormError("");
    startTransition(async () => {
      const r = await onCreate(input);
      if (!r.ok) return setFormError(r.error);
      setCreating(false);
      setNotice({ kind: "ok", text: "Se creó el QR." });
    });
  }

  function revocar(c: QrCodeRow) {
    if (!window.confirm(`¿Revocar el QR ${c.code} de "${c.holder_name}"? Dejará de abrir en todos los lectores.`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onDelete(c.id);
      if (r.ok && viewing?.id === c.id) setViewing(null);
      setNotice(r.ok ? { kind: "ok", text: `Se revocó el QR ${c.code}.` } : { kind: "error", text: r.error });
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">QR</h2>
        <button type="button" className="btn" onClick={abrirAlta}>
          Nuevo QR
        </button>
      </div>

      {creating && (
        <section className="panel" aria-labelledby="qr-form">
          <h3 id="qr-form" className="mb-4 text-lg font-semibold">
            Nuevo QR
          </h3>
          <QrCodeForm holders={holders} defaultHolderId={filter} error={formError} pending={pendiente} onSubmit={crear} onCancel={() => setCreating(false)} />
        </section>
      )}

      {viewing && (
        <section className="panel grid justify-items-start gap-4" aria-labelledby="qr-ver">
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <h3 id="qr-ver" className="text-lg font-semibold [overflow-wrap:anywhere]">
              QR de {viewing.holder_name}
              {viewing.label !== "" && ` (${viewing.label})`}
            </h3>
            <button type="button" className="btn-quiet" onClick={() => setViewing(null)}>
              Cerrar
            </button>
          </div>
          <QrImage code={viewing.code} />
        </section>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Filtrar por anfitrión
          <select className="field" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Todos</option>
            {holders.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Filtrar por estado
          <select className="field" value={status} onChange={(e) => setStatus(e.target.value as Estado)}>
            <option value="">Todos</option>
            {(Object.keys(QR_STATUS_LABELS) as QrCodeRow["status"][]).map((s) => (
              <option key={s} value={s}>
                {QR_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Anfitrión</th>
                <th scope="col" className="px-4 py-2 font-medium">Etiqueta</th>
                <th scope="col" className="px-4 py-2 font-medium">Vigencia (hora de México)</th>
                <th scope="col" className="px-4 py-2 font-medium">Usos máximos</th>
                <th scope="col" className="px-4 py-2 font-medium">Estado</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <tr key={c.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3 font-medium [overflow-wrap:anywhere]">{c.holder_name}</td>
                  <td className="px-4 py-3 [overflow-wrap:anywhere]">{c.label || "—"}</td>
                  <td className="px-4 py-3 tabular-nums">
                    <span className="block whitespace-nowrap">{formatDateTime(c.valid_from)}</span>
                    <span className="block whitespace-nowrap text-muted">a {formatDateTime(c.valid_until)}</span>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{c.max_uses}</td>
                  <td className="px-4 py-3">
                    <span className={`tag ${c.status === "active" ? "text-signal" : "text-muted"}`}>{QR_STATUS_LABELS[c.status]}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-4 whitespace-nowrap">
                      <button type="button" className="link-action" onClick={() => setViewing(c)}>
                        Ver QR <span className="sr-only">{c.code}</span>
                      </button>
                      <button type="button" className="link-danger" disabled={pendiente} onClick={() => revocar(c)}>
                        Revocar <span className="sr-only">el QR {c.code}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibles.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted">
                    {codes.length === 0 ? "Aún no hay QR. Crea el primero con Nuevo QR." : "Ningún QR coincide con el filtro."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
