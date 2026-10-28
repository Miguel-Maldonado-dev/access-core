"use client";

import { useState, useTransition } from "react";
import HolderForm from "@/components/access/HolderForm";
import Notices, { type Notice } from "@/components/Notices";
import { deleteHolderMessage, holderKindLabel } from "@/lib/access-view";
import type { ActionResult } from "@/lib/actions";
import type { HolderInput, HolderRow } from "@/lib/holders";

interface Props {
  holders: HolderRow[];
  /** Solo el `admin` ve el PIN actual al editar; el técnico solo puede reemplazarlo o quitarlo. */
  canSeePin: boolean;
  /** `holderId` null crea; con id edita. */
  onSave: (holderId: string | null, input: HolderInput) => Promise<ActionResult<{ id: string }>>;
  onDelete: (holderId: string) => Promise<ActionResult>;
  onRevealPin: (holderId: string) => Promise<ActionResult<string | null>>;
}

type Editing = { holder?: HolderRow; currentPin: string | null } | null;

/** Pestaña Titulares: buscar, crear, editar (con PIN) y borrar. */
export default function HoldersManager({ holders, canSeePin, onSave, onDelete, onRevealPin }: Props) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [pendiente, startTransition] = useTransition();

  const q = query.trim().toLowerCase();
  const visibles = q
    ? holders.filter((h) => [h.name, h.department, h.address, h.notes].some((t) => t.toLowerCase().includes(q)))
    : holders;

  function abrir(holder?: HolderRow) {
    setNotice(null);
    setFormError("");
    // El PIN actual se pide solo si el rol lo permite; nunca viene en la lista.
    if (holder && canSeePin && holder.has_pin) {
      startTransition(async () => {
        const r = await onRevealPin(holder.id);
        if (r.ok) setEditing({ holder, currentPin: r.data });
        else setNotice({ kind: "error", text: r.error });
      });
      return;
    }
    setEditing({ holder, currentPin: null });
  }

  function guardar(input: HolderInput) {
    const holder = editing?.holder;
    setFormError("");
    startTransition(async () => {
      const r = await onSave(holder?.id ?? null, input);
      if (!r.ok) return setFormError(r.error);
      setEditing(null);
      setNotice({ kind: "ok", text: holder ? `Se guardó ${input.name}.` : `Se creó ${input.name}.` });
    });
  }

  function borrar(h: HolderRow) {
    if (!window.confirm(deleteHolderMessage(h))) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onDelete(h.id);
      setNotice(r.ok ? { kind: "ok", text: `Se borró ${h.name}.` } : { kind: "error", text: r.error });
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Titulares</h2>
        <button type="button" className="btn" onClick={() => abrir()}>
          Nuevo titular
        </button>
      </div>

      {editing && (
        <section className="panel" aria-labelledby="titular-form">
          <h3 id="titular-form" className="mb-4 text-lg font-semibold">
            {editing.holder ? "Editar titular" : "Nuevo titular"}
          </h3>
          <HolderForm
            key={editing.holder?.id ?? "nuevo"}
            holder={editing.holder}
            currentPin={editing.currentPin}
            canSeePin={canSeePin}
            error={formError}
            pending={pendiente}
            onSubmit={guardar}
            onCancel={() => setEditing(null)}
          />
        </section>
      )}

      <label className="block max-w-sm text-sm font-medium">
        Buscar
        <input
          className="field"
          type="search"
          placeholder="Nombre, departamento o dirección"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Nombre</th>
                <th scope="col" className="px-4 py-2 font-medium">Tipo</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Tarjetas</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Controles</th>
                <th scope="col" className="px-4 py-2 font-medium">PIN</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((h) => (
                <tr key={h.id} className="border-b border-line align-top last:border-0">
                  <th scope="row" className="px-4 py-3 font-medium [overflow-wrap:anywhere]">
                    {h.name}
                    {(h.department || h.address) && (
                      <span className="block font-normal text-muted">
                        {[h.department, h.address].filter(Boolean).join(", ")}
                      </span>
                    )}
                  </th>
                  <td className="px-4 py-3">{holderKindLabel(h.kind)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{h.card_count}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{h.control_count}</td>
                  <td className="px-4 py-3">{h.has_pin ? "Sí" : "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-4 whitespace-nowrap">
                      <button type="button" className="link-action" disabled={pendiente} onClick={() => abrir(h)}>
                        Editar <span className="sr-only">a {h.name}</span>
                      </button>
                      <button type="button" className="link-danger" disabled={pendiente} onClick={() => borrar(h)}>
                        Borrar <span className="sr-only">a {h.name}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibles.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted">
                    {holders.length === 0
                      ? "Aún no hay titulares. Crea el primero con Nuevo titular."
                      : "Ningún titular coincide con la búsqueda."}
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
