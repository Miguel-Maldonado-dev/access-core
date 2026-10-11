"use client";

import { useEffect, useState } from "react";
import ControlForm, { type ControlPayload } from "@/components/ControlForm";
import { apiFetch } from "@/lib/api";
import { errorMessage, useApiList } from "@/lib/useApiList";
import { outputLabel } from "@/lib/format";
import type { Control, Holder } from "@/lib/types";

type Editing = { control?: Control } | null;

export default function ControlsPage() {
  const [holders, setHolders] = useState<Holder[]>([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [formError, setFormError] = useState("");
  const { items: controls, error, setError, loaded, reload } = useApiList<Control>(
    `/api/controls${filter === "" ? "" : `?holder_id=${encodeURIComponent(filter)}`}`,
  );

  useEffect(() => {
    apiFetch<Holder[]>("/api/holders").then(setHolders, (err) => setError(errorMessage(err)));
  }, [setError]);

  function open(next: Editing) {
    setFormError("");
    setEditing(next);
  }

  async function save(payload: ControlPayload) {
    const control = editing?.control;
    try {
      await apiFetch(control ? `/api/controls/${control.control_id}` : "/api/controls", {
        method: control ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setEditing(null);
      reload();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  async function remove(c: Control) {
    if (!confirm(`¿Borrar el control ${c.control_id} de "${c.holder_name}"?`)) return;
    try {
      await apiFetch(`/api/controls/${c.control_id}`, { method: "DELETE" });
      setError("");
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Controles</h1>
        <button type="button" className="btn" onClick={() => open({})}>
          Nuevo control
        </button>
      </div>

      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {editing && (
        <section className="panel" aria-label={editing.control ? "Editar control" : "Nuevo control"}>
          <h2 className="mb-4 text-lg font-semibold">{editing.control ? "Editar control" : "Nuevo control"}</h2>
          <ControlForm
            key={editing.control?.control_id ?? "nuevo"}
            control={editing.control}
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
              <th className="px-4 py-2 font-medium">Control</th>
              <th className="px-4 py-2 font-medium">Titular</th>
              <th className="px-4 py-2 font-medium">Descripción</th>
              <th className="px-4 py-2 font-medium">Botones</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {controls.map((c) => (
              <tr key={c.control_id} className="border-b border-line align-top last:border-0">
                <td className="px-4 py-2 font-medium tabular-nums">{c.control_id}</td>
                <td className="px-4 py-2">{c.holder_name}</td>
                <td className="px-4 py-2">{c.description || "-"}</td>
                <td className="px-4 py-2">
                  <ul className="grid gap-0.5 tabular-nums">
                    {c.buttons.map((b, i) =>
                      b.rf_code === null ? null : (
                        <li key={i}>
                          Botón {i + 1}: {b.rf_code} →{" "}
                          {b.output_id === null ? "Sin asignar" : outputLabel(b.output_id)}
                        </li>
                      ),
                    )}
                  </ul>
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <button type="button" className="mr-3 font-medium text-signal underline" onClick={() => open({ control: c })}>
                    Editar
                  </button>
                  <button type="button" className="font-medium text-danger underline" onClick={() => void remove(c)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
            {loaded && controls.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted">
                  {filter === "" ? "Aún no hay controles. Registra el primero con Nuevo control." : "Este titular no tiene controles."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
