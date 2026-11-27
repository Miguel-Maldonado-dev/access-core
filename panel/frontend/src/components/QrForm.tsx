"use client";

import { useState, type FormEvent } from "react";
import { mexicoLocalToIso } from "@/lib/time";
import type { Holder } from "@/lib/types";

export interface QrPayload {
  holder_id: number;
  label: string;
  valid_from: string;
  valid_until: string;
  max_uses: number;
}

interface Props {
  holders: Holder[];
  error?: string;
  onSubmit: (payload: QrPayload) => void | Promise<void>;
  onCancel?: () => void;
}

export default function QrForm({ holders, error = "", onSubmit, onCancel }: Props) {
  const [holderId, setHolderId] = useState("");
  const [label, setLabel] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [uses, setUses] = useState("1");
  const [localError, setLocalError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (holderId === "") return setLocalError("Elige un anfitrión.");
    if (from === "" || until === "") return setLocalError("Indica desde y hasta cuándo vale el QR.");
    const maxUses = Number(uses);
    if (uses.trim() === "" || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      return setLocalError("Los usos deben estar entre 1 y 100.");
    }
    const validFrom = mexicoLocalToIso(from);
    const validUntil = mexicoLocalToIso(until);
    if (validUntil <= validFrom) return setLocalError("La vigencia debe terminar después de empezar.");
    setLocalError("");
    await onSubmit({
      holder_id: Number(holderId),
      label: label.trim(),
      valid_from: validFrom,
      valid_until: validUntil,
      max_uses: maxUses,
    });
  }

  const shown = localError || error;

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      {shown !== "" && (
        <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">
          {shown}
        </p>
      )}
      <label className="text-sm font-medium">
        Anfitrión
        <select className="field" value={holderId} onChange={(e) => setHolderId(e.target.value)}>
          <option value="">Elige un anfitrión</option>
          {holders.map((h) => (
            <option key={h.holder_id} value={h.holder_id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium">
        Etiqueta
        <input className="field" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="text-sm font-medium">
        Desde
        <input className="field" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="text-sm font-medium">
        Hasta
        <input className="field" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
      </label>
      <label className="text-sm font-medium">
        Usos por lector
        <input
          className="field tabular-nums"
          type="number"
          min={1}
          max={100}
          value={uses}
          onChange={(e) => setUses(e.target.value)}
        />
      </label>
      <p className="self-end text-sm text-muted">
        Las horas son de la Ciudad de México. Cada lector acepta el QR hasta el número de usos indicado.
      </p>
      <div className="flex gap-3 sm:col-span-2">
        <button type="submit" className="btn">
          Crear QR
        </button>
        {onCancel && (
          <button type="button" className="btn-quiet" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}
