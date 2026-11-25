"use client";

import { useState, useTransition } from "react";
import PhoneForm from "@/components/access/PhoneForm";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import type { PhoneInput, PhoneRow } from "@/lib/phones";

interface Props {
  phones: PhoneRow[];
  holders: { id: string; name: string }[];
  /** Titular del filtro al abrir la página (`?holder=` desde la ficha del titular). */
  initialHolder?: string;
  /** `phoneId` null crea; con id edita. */
  onSave: (phoneId: string | null, input: PhoneInput) => Promise<ActionResult<{ id: string }>>;
  onDelete: (phoneId: string) => Promise<ActionResult>;
}

type Editing = { phone?: PhoneRow } | null;

/** Pestaña Teléfonos: números de 10 dígitos con los que un titular abre llamando; filtrar por titular o buscar. */
export default function PhonesManager({ phones, holders, initialHolder = "", onSave, onDelete }: Props) {
  const [filter, setFilter] = useState(() => (holders.some((h) => h.id === initialHolder) ? initialHolder : ""));
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [pendiente, startTransition] = useTransition();

  const q = query.trim().toLowerCase();
  // Solo espacios o guiones no buscan por número (si no, cualquier número coincidiría).
  const qNumero = q.replace(/[\s-]/g, "");
  const visibles = phones.filter(
    (t) =>
      (filter === "" || t.holder_id === filter) &&
      (q === "" ||
        (qNumero !== "" && t.number.includes(qNumero)) ||
        t.holder_name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)),
  );

  function abrir(next: Editing) {
    setNotice(null);
    setFormError("");
    setEditing(next);
  }

  function guardar(input: PhoneInput) {
    const phone = editing?.phone;
    setFormError("");
    startTransition(async () => {
      const r = await onSave(phone?.id ?? null, input);
      if (!r.ok) return setFormError(r.error);
      setEditing(null);
      setNotice({ kind: "ok", text: phone ? `Se guardó el teléfono ${input.number}.` : `Se registró el teléfono ${input.number}.` });
    });
  }

  function borrar(t: PhoneRow) {
    if (!window.confirm(`¿Borrar el teléfono ${t.number} de "${t.holder_name}"?`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onDelete(t.id);
      setNotice(r.ok ? { kind: "ok", text: `Se borró el teléfono ${t.number}.` } : { kind: "error", text: r.error });
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Teléfonos</h2>
        <button type="button" className="btn" onClick={() => abrir({})}>
          Nuevo teléfono
        </button>
      </div>

      {editing && (
        <section className="panel" aria-labelledby="telefono-form">
          <h3 id="telefono-form" className="mb-4 text-lg font-semibold">
            {editing.phone ? "Editar teléfono" : "Nuevo teléfono"}
          </h3>
          <PhoneForm
            key={editing.phone?.id ?? "nuevo"}
            phone={editing.phone}
            holders={holders}
            defaultHolderId={filter}
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
            placeholder="Número, titular o descripción"
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
                <th scope="col" className="px-4 py-2 font-medium">Número</th>
                <th scope="col" className="px-4 py-2 font-medium">Titular</th>
                <th scope="col" className="px-4 py-2 font-medium">Descripción</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((t) => (
                <tr key={t.id} className="border-b border-line align-top last:border-0">
                  <th scope="row" className="px-4 py-3 font-medium tabular-nums">{t.number}</th>
                  <td className="px-4 py-3 [overflow-wrap:anywhere]">{t.holder_name}</td>
                  <td className="px-4 py-3 [overflow-wrap:anywhere]">{t.description || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-4 whitespace-nowrap">
                      <button type="button" className="link-action" disabled={pendiente} onClick={() => abrir({ phone: t })}>
                        Editar <span className="sr-only">el teléfono {t.number}</span>
                      </button>
                      <button type="button" className="link-danger" disabled={pendiente} onClick={() => borrar(t)}>
                        Borrar <span className="sr-only">el teléfono {t.number}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibles.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted">
                    {phones.length === 0
                      ? "Aún no hay teléfonos. Registra el primero con Nuevo teléfono."
                      : "Ningún teléfono coincide con el filtro."}
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
