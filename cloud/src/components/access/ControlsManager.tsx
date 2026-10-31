"use client";

import { useState, useTransition } from "react";
import ControlForm, { type ControlPanel } from "@/components/access/ControlForm";
import Notices, { type Notice } from "@/components/Notices";
import { controlButtonSummary } from "@/lib/access-view";
import type { ActionResult } from "@/lib/actions";
import type { ControlInput, ControlRow } from "@/lib/controls";

interface Props {
  controls: ControlRow[];
  holders: { id: string; name: string }[];
  /** Paneles vinculados de la instalación, con los alias de sus salidas. */
  panels: ControlPanel[];
  /** `controlId` null crea; con id edita. */
  onSave: (controlId: string | null, input: ControlInput) => Promise<ActionResult<{ id: string }>>;
  onDelete: (controlId: string) => Promise<ActionResult>;
}

type Editing = { control?: ControlRow } | null;

/** Pestaña Controles: controles RF con sus botones; cada botón tiene su código y su salida en cada panel. */
export default function ControlsManager({ controls, holders, panels, onSave, onDelete }: Props) {
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [pendiente, startTransition] = useTransition();

  const visibles = filter === "" ? controls : controls.filter((c) => c.holder_id === filter);

  function abrir(next: Editing) {
    setNotice(null);
    setFormError("");
    setEditing(next);
  }

  function guardar(input: ControlInput) {
    const control = editing?.control;
    setFormError("");
    startTransition(async () => {
      const r = await onSave(control?.id ?? null, input);
      if (!r.ok) return setFormError(r.error);
      setEditing(null);
      setNotice({ kind: "ok", text: control ? "Se guardó el control." : "Se registró el control." });
    });
  }

  function borrar(c: ControlRow) {
    if (!window.confirm(`¿Borrar el control de "${c.holder_name}"?`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onDelete(c.id);
      setNotice(r.ok ? { kind: "ok", text: "Se borró el control." } : { kind: "error", text: r.error });
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Controles</h2>
        <button type="button" className="btn" onClick={() => abrir({})}>
          Nuevo control
        </button>
      </div>

      {editing && (
        <section className="panel" aria-labelledby="control-form">
          <h3 id="control-form" className="mb-4 text-lg font-semibold">
            {editing.control ? "Editar control" : "Nuevo control"}
          </h3>
          <ControlForm
            key={editing.control?.id ?? "nuevo"}
            control={editing.control}
            holders={holders}
            panels={panels}
            error={formError}
            pending={pendiente}
            onSubmit={guardar}
            onCancel={() => setEditing(null)}
          />
        </section>
      )}

      <label className="block max-w-sm text-sm font-medium">
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

      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Titular</th>
                <th scope="col" className="px-4 py-2 font-medium">Descripción</th>
                <th scope="col" className="px-4 py-2 font-medium">Botones</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <tr key={c.id} className="border-b border-line align-top last:border-0">
                  <th scope="row" className="px-4 py-3 font-medium [overflow-wrap:anywhere]">{c.holder_name}</th>
                  <td className="px-4 py-3 [overflow-wrap:anywhere]">{c.description || "—"}</td>
                  <td className="px-4 py-3">
                    {c.buttons.length === 0 ? (
                      <span className="text-muted">Sin botones</span>
                    ) : (
                      <ul className="grid gap-0.5 tabular-nums">
                        {c.buttons.map((b) => (
                          <li key={b.id}>{controlButtonSummary(b, panels)}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-4 whitespace-nowrap">
                      <button type="button" className="link-action" disabled={pendiente} onClick={() => abrir({ control: c })}>
                        Editar <span className="sr-only">el control de {c.holder_name}</span>
                      </button>
                      <button type="button" className="link-danger" disabled={pendiente} onClick={() => borrar(c)}>
                        Borrar <span className="sr-only">el control de {c.holder_name}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibles.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted">
                    {controls.length === 0
                      ? "Aún no hay controles. Registra el primero con Nuevo control."
                      : "Este titular no tiene controles."}
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
