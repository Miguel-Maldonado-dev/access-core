"use client";

import { useState, type FormEvent } from "react";
import type { Holder, Phone } from "@/lib/types";

export interface PhonePayload {
  holder_id: number;
  number: string;
  description: string;
}

interface Props {
  phone?: Phone;
  holders: Holder[];
  error?: string;
  onSubmit: (payload: PhonePayload) => void | Promise<void>;
  onCancel?: () => void;
}

const TEN_DIGITS = /^[0-9]{10}$/;

export default function PhoneForm({ phone, holders, error = "", onSubmit, onCancel }: Props) {
  const [number, setNumber] = useState(phone?.number ?? "");
  const [holderId, setHolderId] = useState(phone ? String(phone.holder_id) : "");
  const [description, setDescription] = useState(phone?.description ?? "");
  const [localError, setLocalError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cleaned = number.replace(/[\s-]/g, "");
    if (!TEN_DIGITS.test(cleaned)) {
      setLocalError("El número debe tener 10 dígitos.");
      return;
    }
    if (holderId === "") {
      setLocalError("Elige un titular.");
      return;
    }
    setLocalError("");
    await onSubmit({ holder_id: Number(holderId), number: cleaned, description: description.trim() });
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
        Número
        <input
          className="field tabular-nums"
          type="tel"
          inputMode="tel"
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
            <option key={h.holder_id} value={h.holder_id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium sm:col-span-2">
        Descripción
        <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="flex gap-3 sm:col-span-2">
        <button type="submit" className="btn">
          Guardar
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
