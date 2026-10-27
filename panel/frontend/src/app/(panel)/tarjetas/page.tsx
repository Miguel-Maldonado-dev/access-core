"use client";

import { useEffect, useState } from "react";
import CardForm, { type CardPayload } from "@/components/CardForm";
import { apiFetch } from "@/lib/api";
import { errorMessage, useApiList } from "@/lib/useApiList";
import type { Card, Holder } from "@/lib/types";

type Editing = { card?: Card } | null;

export default function CardsPage() {
  const [holders, setHolders] = useState<Holder[]>([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [formError, setFormError] = useState("");
  const { items: cards, error, setError, loaded, reload } = useApiList<Card>(
    `/api/cards${filter === "" ? "" : `?holder_id=${encodeURIComponent(filter)}`}`,
  );

  useEffect(() => {
    apiFetch<Holder[]>("/api/holders").then(setHolders, (err) => setError(errorMessage(err)));
  }, [setError]);

  function open(next: Editing) {
    setFormError("");
    setEditing(next);
  }

  async function save(payload: CardPayload) {
    const card = editing?.card;
    try {
      await apiFetch(card ? `/api/cards/${card.card_code}` : "/api/cards", {
        method: card ? "PUT" : "POST",
        body: JSON.stringify(card ? { holder_id: payload.holder_id, description: payload.description } : payload),
      });
      setEditing(null);
      reload();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  async function remove(c: Card) {
    if (!confirm(`¿Borrar la tarjeta ${c.card_code} de "${c.holder_name}"?`)) return;
    try {
      await apiFetch(`/api/cards/${c.card_code}`, { method: "DELETE" });
      setError("");
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Tarjetas</h1>
        <button type="button" className="btn" onClick={() => open({})}>
          Nueva tarjeta
        </button>
      </div>

      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {editing && (
        <section className="panel" aria-label={editing.card ? "Editar tarjeta" : "Nueva tarjeta"}>
          <h2 className="mb-4 text-lg font-semibold">{editing.card ? "Editar tarjeta" : "Nueva tarjeta"}</h2>
          <CardForm
            key={editing.card?.card_code ?? "nueva"}
            card={editing.card}
            holders={holders}
            error={formError}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        </section>
      )}

      <label className="block max-w-sm text-sm font-medium">
        Filtrar por titular
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
              <th className="px-4 py-2 font-medium">Código</th>
              <th className="px-4 py-2 font-medium">Titular</th>
              <th className="px-4 py-2 font-medium">Descripción</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.card_code} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium tabular-nums">{c.card_code}</td>
                <td className="px-4 py-2">{c.holder_name}</td>
                <td className="px-4 py-2">{c.description || "-"}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <button type="button" className="mr-3 font-medium text-signal underline" onClick={() => open({ card: c })}>
                    Editar
                  </button>
                  <button type="button" className="font-medium text-danger underline" onClick={() => void remove(c)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
            {loaded && cards.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  {filter === "" ? "Aún no hay tarjetas. Registra la primera con Nueva tarjeta." : "Este titular no tiene tarjetas."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
