"use client";

import { useEffect, useState } from "react";
import PhoneForm, { type PhonePayload } from "@/components/PhoneForm";
import { apiFetch } from "@/lib/api";
import { errorMessage, useApiList } from "@/lib/useApiList";
import type { CallSettings, Holder, Phone } from "@/lib/types";

type Editing = { phone?: Phone } | null;

export default function PhonesPage() {
  const [holders, setHolders] = useState<Holder[]>([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [formError, setFormError] = useState("");
  const [callsEnabled, setCallsEnabled] = useState<boolean | null>(null);
  const { items: phones, error, setError, loaded, reload } = useApiList<Phone>(
    `/api/phones${filter === "" ? "" : `?holder_id=${encodeURIComponent(filter)}`}`,
  );

  useEffect(() => {
    apiFetch<Holder[]>("/api/holders").then(setHolders, (err) => setError(errorMessage(err)));
  }, [setError]);

  useEffect(() => {
    let ignore = false;
    apiFetch<CallSettings>("/api/calls/settings").then(
      (c) => !ignore && setCallsEnabled(c.enabled),
      () => !ignore && setCallsEnabled(null),
    );
    return () => {
      ignore = true;
    };
  }, []);

  function open(next: Editing) {
    setFormError("");
    setEditing(next);
  }

  async function save(payload: PhonePayload) {
    const phone = editing?.phone;
    try {
      await apiFetch(phone ? `/api/phones/${phone.phone_id}` : "/api/phones", {
        method: phone ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setEditing(null);
      reload();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  async function remove(p: Phone) {
    if (!confirm(`¿Borrar el teléfono ${p.number} de "${p.holder_name}"?`)) return;
    try {
      await apiFetch(`/api/phones/${p.phone_id}`, { method: "DELETE" });
      setError("");
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Teléfonos</h1>
        <button type="button" className="btn" onClick={() => open({})} disabled={callsEnabled === false}>
          Nuevo teléfono
        </button>
      </div>

      {callsEnabled === false && (
        <p role="status" className="rounded border border-line bg-surface px-4 py-3 text-sm">
          El módulo de llamadas está desactivado. Actívalo en Llamadas para agregar teléfonos.
        </p>
      )}

      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {editing && (
        <section className="panel" aria-label={editing.phone ? "Editar teléfono" : "Nuevo teléfono"}>
          <h2 className="mb-4 text-lg font-semibold">{editing.phone ? "Editar teléfono" : "Nuevo teléfono"}</h2>
          <PhoneForm
            key={editing.phone?.phone_id ?? "nuevo"}
            phone={editing.phone}
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
              <th className="px-4 py-2 font-medium">Número</th>
              <th className="px-4 py-2 font-medium">Titular</th>
              <th className="px-4 py-2 font-medium">Descripción</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {phones.map((p) => (
              <tr key={p.phone_id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium tabular-nums">{p.number}</td>
                <td className="px-4 py-2">{p.holder_name}</td>
                <td className="px-4 py-2">{p.description || "-"}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <button type="button" className="mr-3 font-medium text-signal underline" onClick={() => open({ phone: p })}>
                    Editar
                  </button>
                  <button type="button" className="font-medium text-danger underline" onClick={() => void remove(p)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
            {loaded && phones.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  {filter === "" ? "Aún no hay teléfonos. Registra el primero con Nuevo teléfono." : "Este titular no tiene teléfonos."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
