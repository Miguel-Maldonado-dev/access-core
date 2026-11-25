"use client";

import { useState, type FormEvent } from "react";
import { cleanPhone, PHONE_MESSAGE } from "@/lib/phone-view";
import type { PhoneInput, PhoneRow } from "@/lib/phones";

interface Props {
  phone?: PhoneRow;
  holders: { id: string; name: string }[];
  /** Titular preseleccionado en un alta (filtro activo de la lista). */
  defaultHolderId?: string;
  error?: string;
  pending?: boolean;
  onSubmit: (input: PhoneInput) => void;
  onCancel: () => void;
}

export default function PhoneForm({ phone, holders, defaultHolderId = "", error = "", pending = false, onSubmit, onCancel }: Props) {
  const [number, setNumber] = useState(phone?.number ?? "");
  const [holderId, setHolderId] = useState(phone?.holder_id ?? defaultHolderId);
  const [description, setDescription] = useState(phone?.description ?? "");
  const [localError, setLocalError] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const limpio = cleanPhone(number);
    if (limpio === null) return setLocalError(PHONE_MESSAGE);
    if (holderId === "") return setLocalError("Elige un titular.");
    setLocalError("");
    onSubmit({ number: limpio, holder_id: holderId, description: description.trim() });
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
        Número de teléfono
        <input
          className="field tabular-nums"
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          placeholder="10 dígitos"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
      </label>
      <label className="text-sm font-medium">
        Titular
        <select className="field" value={holderId} onChange={(e) => setHolderId(e.target.value)}>
          <option value="">Elige un titular</option>
          {holders.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium sm:col-span-2">
        Descripción
        <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} autoComplete="off" />
      </label>
      <div className="flex gap-3 sm:col-span-2">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" className="btn-quiet" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
