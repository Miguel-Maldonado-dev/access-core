"use client";

import { useState, useTransition } from "react";
import CardForm from "@/components/access/CardForm";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import type { CardInput, CardRow } from "@/lib/cards";

interface Props {
  cards: CardRow[];
  holders: { id: string; name: string }[];
  /** `cardId` null crea; con id edita titular y descripción. */
  onSave: (cardId: string | null, input: CardInput) => Promise<ActionResult<{ id: string }>>;
  onDelete: (cardId: string) => Promise<ActionResult>;
}

type Editing = { card?: CardRow } | null;

/** Pestaña Tarjetas: códigos en decimal; filtrar por titular o por código. */
export default function CardsManager({ cards, holders, onSave, onDelete }: Props) {
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [pendiente, startTransition] = useTransition();

  const q = query.trim().toLowerCase();
  const visibles = cards.filter(
    (c) =>
      (filter === "" || c.holder_id === filter) &&
      (q === "" || String(c.card_code).includes(q) || c.description.toLowerCase().includes(q)),
  );

  function abrir(next: Editing) {
    setNotice(null);
    setFormError("");
    setEditing(next);
  }

  function guardar(input: CardInput) {
    const card = editing?.card;
    setFormError("");
    startTransition(async () => {
      const r = await onSave(card?.id ?? null, input);
      if (!r.ok) return setFormError(r.error);
      setEditing(null);
      setNotice({ kind: "ok", text: card ? `Se guardó la tarjeta ${card.card_code}.` : `Se registró la tarjeta ${input.card_code}.` });
    });
  }

  function borrar(c: CardRow) {
    if (!window.confirm(`¿Borrar la tarjeta ${c.card_code} de "${c.holder_name}"?`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onDelete(c.id);
      setNotice(r.ok ? { kind: "ok", text: `Se borró la tarjeta ${c.card_code}.` } : { kind: "error", text: r.error });
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Tarjetas</h2>
        <button type="button" className="btn" onClick={() => abrir({})}>
          Nueva tarjeta
        </button>
      </div>

      {editing && (
        <section className="panel" aria-labelledby="tarjeta-form">
          <h3 id="tarjeta-form" className="mb-4 text-lg font-semibold">
            {editing.card ? "Editar tarjeta" : "Nueva tarjeta"}
          </h3>
          <CardForm
            key={editing.card?.id ?? "nueva"}
            card={editing.card}
            holders={holders}
            error={formError}
            pending={pendiente}
            onSubmit={guardar}
            onCancel={() => setEditing(null)}
          />
        </section>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Filtrar por titular
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
          Buscar
          <input
            className="field"
            type="search"
            placeholder="Código o descripción"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Código</th>
                <th scope="col" className="px-4 py-2 font-medium">Titular</th>
                <th scope="col" className="px-4 py-2 font-medium">Descripción</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <tr key={c.id} className="border-b border-line align-top last:border-0">
                  <th scope="row" className="px-4 py-3 font-medium tabular-nums">{c.card_code}</th>
                  <td className="px-4 py-3 [overflow-wrap:anywhere]">{c.holder_name}</td>
                  <td className="px-4 py-3 [overflow-wrap:anywhere]">{c.description || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-4 whitespace-nowrap">
                      <button type="button" className="link-action" disabled={pendiente} onClick={() => abrir({ card: c })}>
                        Editar <span className="sr-only">la tarjeta {c.card_code}</span>
                      </button>
                      <button type="button" className="link-danger" disabled={pendiente} onClick={() => borrar(c)}>
                        Borrar <span className="sr-only">la tarjeta {c.card_code}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibles.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted">
                    {cards.length === 0
                      ? "Aún no hay tarjetas. Registra la primera con Nueva tarjeta."
                      : "Ninguna tarjeta coincide con el filtro."}
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
