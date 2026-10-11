"use client";

import { useState, type FormEvent } from "react";
import { parseCode } from "@/lib/codes";
import type { Card, Holder } from "@/lib/types";

export interface CardPayload {
  card_code: number;
  holder_id: number;
  description: string;
}

interface Props {
  card?: Card;
  holders: Holder[];
  error?: string;
  onSubmit: (payload: CardPayload) => void | Promise<void>;
  onCancel?: () => void;
}

export default function CardForm({ card, holders, error = "", onSubmit, onCancel }: Props) {
  const [code, setCode] = useState(card ? String(card.card_code) : "");
  const [holderId, setHolderId] = useState(card ? String(card.holder_id) : "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [localError, setLocalError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    let card_code: number;
    try {
      card_code = card ? card.card_code : parseCode(code);
    } catch (err) {
      setLocalError((err as Error).message);
      return;
    }
    if (holderId === "") {
      setLocalError("Elige un titular.");
      return;
    }
    setLocalError("");
    await onSubmit({ card_code, holder_id: Number(holderId), description: description.trim() });
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
        Código de tarjeta
        <input
          className="field tabular-nums"
          inputMode="numeric"
          value={code}
          readOnly={card !== undefined}
          onChange={(e) => setCode(e.target.value)}
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
