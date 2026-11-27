"use client";

import { useState, type FormEvent } from "react";
import type { QrCodeInput } from "@/lib/qr-codes";
import {
  mexicoInputIn,
  mexicoLocalToIso,
  QR_DATES_MESSAGE,
  QR_MAX_USES,
  QR_RANGE_MESSAGE,
  QR_USES_MESSAGE,
} from "@/lib/qr-view";

interface Props {
  holders: { id: string; name: string }[];
  /** Anfitrión preseleccionado (filtro activo de la lista). */
  defaultHolderId?: string;
  error?: string;
  pending?: boolean;
  onSubmit: (input: QrCodeInput) => void;
  onCancel: () => void;
}

/** Alta de un QR: anfitrión, etiqueta, vigencia (hora de México) y usos máximos. Un QR no se edita. */
export default function QrCodeForm({
  holders,
  defaultHolderId = "",
  error = "",
  pending = false,
  onSubmit,
  onCancel,
}: Props) {
  const [holderId, setHolderId] = useState(defaultHolderId);
  const [label, setLabel] = useState("");
  const [from, setFrom] = useState(() => mexicoInputIn(0));
  const [until, setUntil] = useState(() => mexicoInputIn(24));
  const [uses, setUses] = useState("1");
  const [localError, setLocalError] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (holderId === "") return setLocalError("Elige un anfitrión.");
    const desde = mexicoLocalToIso(from);
    const hasta = mexicoLocalToIso(until);
    if (desde === null || hasta === null)
      return setLocalError(QR_DATES_MESSAGE);
    if (Date.parse(hasta) <= Date.parse(desde))
      return setLocalError(QR_RANGE_MESSAGE);
    const usos = /^\d+$/.test(uses.trim()) ? Number(uses) : Number.NaN;
    if (!Number.isInteger(usos) || usos < 1 || usos > QR_MAX_USES)
      return setLocalError(QR_USES_MESSAGE);
    setLocalError("");
    onSubmit({
      holder_id: holderId,
      label: label.trim(),
      valid_from: desde,
      valid_until: hasta,
      max_uses: usos,
    });
  }

  const mostrado = localError || error;

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      {mostrado !== "" && (
        <p role="alert" className="notice-error sm:col-span-2">
          {mostrado}
        </p>
      )}
      <label className="text-sm font-medium">
        Anfitrión
        <select
          className="field"
          value={holderId}
          onChange={(e) => setHolderId(e.target.value)}
        >
          <option value="">Elige un anfitrión</option>
          {holders.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium">
        Etiqueta
        <input
          className="field"
          value={label}
          maxLength={60}
          placeholder="Visita, repartidor…"
          onChange={(e) => setLabel(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="text-sm font-medium">
        Desde
        <input
          className="field tabular-nums"
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <label className="text-sm font-medium">
        Hasta
        <input
          className="field tabular-nums"
          type="datetime-local"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
        />
      </label>
      <div>
        <label className="text-sm font-medium">
          Usos máximos
          <input
            className="field tabular-nums"
            type="number"
            inputMode="numeric"
            min={1}
            max={QR_MAX_USES}
            value={uses}
            onChange={(e) => setUses(e.target.value)}
          />
        </label>
        <p className="mt-1 text-xs text-muted">
          Se cuentan por lector. Las horas son de México.
        </p>
      </div>
      <div className="flex gap-3 sm:col-span-2">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Creando…" : "Crear QR"}
        </button>
        <button type="button" className="btn-quiet" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
