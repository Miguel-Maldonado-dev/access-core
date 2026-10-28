"use client";

import { useState, type FormEvent } from "react";
import { parseCode } from "@/lib/access-view";
import type { CardInput, CardRow } from "@/lib/cards";

interface Props {
  card?: CardRow;
  holders: { id: string; name: string }[];
  error?: string;
  pending?: boolean;
  onSubmit: (input: CardInput) => void;
  onCancel: () => void;
}

export default function CardForm({ card, holders, error = "", pending = false, onSubmit, onCancel }: Props) {
  const [code, setCode] = useState(card ? String(card.card_code) : "");
  const [holderId, setHolderId] = useState(card?.holder_id ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [localError, setLocalError] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    let card_code: number;
    try {
      card_code = card ? card.card_code : parseCode(code);
    } catch (err) {
      return setLocalError((err as Error).message);
    }
    if (holderId === "") return setLocalError("Elige un titular.");
    setLocalError("");
    onSubmit({ card_code, holder_id: holderId, description: description.trim() });
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
        Código de tarjeta
        <input
          className="field tabular-nums"
          inputMode="numeric"
          autoComplete="off"
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
