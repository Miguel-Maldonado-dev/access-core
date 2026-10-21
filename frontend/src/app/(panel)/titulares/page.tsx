"use client";

import { useEffect, useState } from "react";
import HolderForm, { type HolderPayload } from "@/components/HolderForm";
import { apiFetch } from "@/lib/api";
import { errorMessage, useApiList } from "@/lib/useApiList";
import { holderKindLabel } from "@/lib/format";
import { deleteHolderMessage } from "@/lib/messages";
import type { Holder, Permission } from "@/lib/types";

type Editing = { holder?: Holder } | null;

export default function HoldersPage() {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const { items: holders, error, setError, loaded, reload } = useApiList<Holder>(
    `/api/holders?q=${encodeURIComponent(search)}`,
  );

  useEffect(() => {
    apiFetch<Permission[]>("/api/permissions").then(setPermissions, (err) => setError(errorMessage(err)));
  }, [setError]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  async function save(payload: HolderPayload) {
    const holder = editing?.holder;
    try {
      await apiFetch(holder ? `/api/holders/${holder.holder_id}` : "/api/holders", {
        method: holder ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setEditing(null);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(h: Holder) {
    if (!confirm(deleteHolderMessage(h))) return;
    try {
      await apiFetch(`/api/holders/${h.holder_id}`, { method: "DELETE" });
      setError("");
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Titulares</h1>
        <button type="button" className="btn" onClick={() => setEditing({})}>
          Nuevo titular
        </button>
      </div>

      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {editing && (
        <section className="panel" aria-label={editing.holder ? "Editar titular" : "Nuevo titular"}>
          <h2 className="mb-4 text-lg font-semibold">{editing.holder ? "Editar titular" : "Nuevo titular"}</h2>
          <HolderForm
            key={editing.holder?.holder_id ?? "nuevo"}
            holder={editing.holder}
            permissions={permissions}
            onSubmit={save}
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

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-paper text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Nombre</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 text-right font-medium">Tarjetas</th>
              <th className="px-4 py-2 text-right font-medium">Controles</th>
              <th className="px-4 py-2 font-medium">Permisos</th>
              <th className="px-4 py-2 font-medium">PIN</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {holders.map((h) => (
              <tr key={h.holder_id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium">{h.name}</td>
                <td className="px-4 py-2">{holderKindLabel(h.kind)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{h.card_count}</td>
                <td className="px-4 py-2 text-right tabular-nums">{h.control_count}</td>
                <td className="px-4 py-2">{h.permission_ids.length > 0 ? h.permission_ids.join(", ") : "-"}</td>
                <td className="px-4 py-2">{h.pin !== null ? "Sí" : "—"}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <button type="button" className="mr-3 font-medium text-signal underline" onClick={() => setEditing({ holder: h })}>
                    Editar
                  </button>
                  <button type="button" className="font-medium text-danger underline" onClick={() => void remove(h)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
            {loaded && holders.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-muted">
                  {query === "" ? "Aún no hay titulares. Crea el primero con Nuevo titular." : "Ningún titular coincide con la búsqueda."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
