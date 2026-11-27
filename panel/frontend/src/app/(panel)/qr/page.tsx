"use client";

import { useEffect, useState, type FormEvent } from "react";
import QrForm, { type QrPayload } from "@/components/QrForm";
import QrImage from "@/components/QrImage";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useApiList, useApiResource } from "@/lib/useApiList";
import type { Holder, QrCode, QrSettings, QrStatus } from "@/lib/types";

const STATUS: Record<QrStatus, { label: string; className: string }> = {
  pending: { label: "Pendiente", className: "text-muted" },
  active: { label: "Vigente", className: "font-medium text-signal" },
  expired: { label: "Vencido", className: "text-muted line-through" },
};

const INITIAL_SETTINGS: QrSettings = { digit: 9, max_active: 1000, editable: true };

function usesText(qr: QrCode): string {
  const parts = Object.entries(qr.uses)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([reader, n]) => `L${Number(reader) + 1}: ${n}/${qr.max_uses}`);
  return parts.length > 0 ? parts.join(" ") : "Sin usos";
}

function Settings() {
  const { data, error: loadError, loaded } = useApiResource<QrSettings>("/api/qr-settings", INITIAL_SETTINGS);
  if (!loaded) return null;
  if (loadError !== "") {
    return (
      <section className="panel" aria-label="Ajustes de QR">
        <h2 className="mb-3 text-lg font-semibold">Ajustes de QR</h2>
        <p role="alert" className="text-sm font-medium text-danger">
          {loadError}
        </p>
      </section>
    );
  }
  // La clave reinicia el formulario cuando llegan los valores del servidor.
  return <SettingsForm key={`${data.digit}-${data.max_active}-${data.editable}`} initial={data} />;
}

function SettingsForm({ initial }: { initial: QrSettings }) {
  const [editable, setEditable] = useState(initial.editable);
  const [digit, setDigit] = useState(String(initial.digit));
  const [maxActive, setMaxActive] = useState(String(initial.max_active));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const d = Number(digit);
    const m = Number(maxActive);
    if (digit.trim() === "" || !Number.isInteger(d) || d < 1 || d > 9) return setError("El dígito debe estar entre 1 y 9.");
    if (maxActive.trim() === "" || !Number.isInteger(m) || m < 1 || m > 100000) {
      return setError("El máximo debe estar entre 1 y 100000.");
    }
    try {
      const next = await apiFetch<QrSettings>("/api/qr-settings", {
        method: "PUT",
        body: JSON.stringify({ digit: d, max_active: m }),
      });
      setEditable(next.editable);
      setError("");
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="panel" aria-label="Ajustes de QR">
      <h2 className="mb-1 text-lg font-semibold">Ajustes de QR</h2>
      <p className="mb-4 max-w-prose text-sm text-muted">
        El primer dígito del código separa los QR de las tarjetas: ninguna tarjeta puede empezar con él.
      </p>
      {!editable && (
        <p className="mb-4 text-sm font-medium">
          Este panel está vinculado a la nube: los ajustes se cambian desde la plataforma.
        </p>
      )}
      {error !== "" && (
        <p role="alert" className="mb-4 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Dígito de QR
          <input
            className="field tabular-nums"
            type="number"
            min={1}
            max={9}
            disabled={!editable}
            value={digit}
            onChange={(e) => setDigit(e.target.value)}
          />
        </label>
        <label className="text-sm font-medium">
          Máximo de QR vigentes
          <input
            className="field tabular-nums"
            type="number"
            min={1}
            max={100000}
            disabled={!editable}
            value={maxActive}
            onChange={(e) => setMaxActive(e.target.value)}
          />
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" className="btn" disabled={!editable}>
            Guardar ajustes
          </button>
          {saved && <span role="status" className="text-sm text-muted">Ajustes guardados.</span>}
        </div>
      </form>
    </section>
  );
}

export default function QrPage() {
  const [holders, setHolders] = useState<Holder[]>([]);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<QrCode | null>(null);
  const [formError, setFormError] = useState("");
  const { items: qrs, error, setError, loaded, reload } = useApiList<QrCode>(
    `/api/qr-codes${filter === "" ? "" : `?holder_id=${encodeURIComponent(filter)}`}`,
  );

  useEffect(() => {
    apiFetch<Holder[]>("/api/holders").then(setHolders, (err) => setError(errorMessage(err)));
  }, [setError]);

  async function create(payload: QrPayload) {
    try {
      const qr = await apiFetch<QrCode>("/api/qr-codes", { method: "POST", body: JSON.stringify(payload) });
      setCreating(false);
      setViewing(qr);
      setError("");
      reload();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  async function revoke(qr: QrCode) {
    const name = qr.label === "" ? String(qr.code) : `${qr.label} (${qr.code})`;
    if (!confirm(`¿Revocar el QR ${name} de "${qr.holder_name}"? Dejará de abrir en todos los lectores.`)) return;
    try {
      await apiFetch(`/api/qr-codes/${qr.qr_id}`, { method: "DELETE" });
      if (viewing?.qr_id === qr.qr_id) setViewing(null);
      setError("");
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">QR</h1>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setFormError("");
            setCreating(true);
          }}
        >
          Nuevo QR
        </button>
      </div>

      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {creating && (
        <section className="panel" aria-label="Nuevo QR">
          <h2 className="mb-4 text-lg font-semibold">Nuevo QR</h2>
          <QrForm holders={holders} error={formError} onSubmit={create} onCancel={() => setCreating(false)} />
        </section>
      )}

      {viewing && (
        <section className="panel" aria-label="Ver QR">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{viewing.label === "" ? "QR sin etiqueta" : viewing.label}</h2>
              <p className="text-sm text-muted">{viewing.holder_name}</p>
            </div>
            <button type="button" className="btn-quiet" onClick={() => setViewing(null)}>
              Cerrar
            </button>
          </div>
          <QrImage code={viewing.code} />
        </section>
      )}

      <label className="block max-w-sm text-sm font-medium">
        Filtrar por anfitrión
        <select className="field" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Todos</option>
          {holders.map((h) => (
            <option key={h.holder_id} value={h.holder_id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-paper text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Anfitrión</th>
              <th className="px-4 py-2 font-medium">Etiqueta</th>
              <th className="px-4 py-2 font-medium">Vigencia</th>
              <th className="px-4 py-2 text-right font-medium">Usos máx.</th>
              <th className="px-4 py-2 font-medium">Estado</th>
              <th className="px-4 py-2 font-medium">Usos por lector</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {qrs.map((q) => (
              <tr key={q.qr_id} className="border-b border-line last:border-0">
                <td className="px-4 py-2">{q.holder_name}</td>
                <td className="px-4 py-2 font-medium">{q.label || "-"}</td>
                <td className="px-4 py-2 tabular-nums">
                  <span className="block">{formatDateTime(q.valid_from).slice(0, -3)}</span>
                  <span className="block text-muted">{formatDateTime(q.valid_until).slice(0, -3)}</span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{q.max_uses}</td>
                <td className={`px-4 py-2 ${STATUS[q.status].className}`}>{STATUS[q.status].label}</td>
                <td className="px-4 py-2 tabular-nums">{usesText(q)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <button type="button" className="mr-3 font-medium text-signal underline" onClick={() => setViewing(q)}>
                    Ver QR
                  </button>
                  <button type="button" className="font-medium text-danger underline" onClick={() => void revoke(q)}>
                    Revocar
                  </button>
                </td>
              </tr>
            ))}
            {loaded && qrs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-muted">
                  {filter === "" ? "Aún no hay QR. Crea el primero con Nuevo QR." : "Este anfitrión no tiene QR."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Settings />
    </div>
  );
}
