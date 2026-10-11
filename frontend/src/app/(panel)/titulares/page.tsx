"use client";

import { useCallback, useEffect, useState } from "react";
import HolderForm, { type HolderPayload } from "@/components/HolderForm";
import { apiFetch } from "@/lib/api";
import { holderKindLabel } from "@/lib/format";
import { deleteHolderMessage } from "@/lib/messages";
import type { Holder, Permission } from "@/lib/types";

type Editing = { holder?: Holder } | null;

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Ocurrió un error inesperado.";
}

export default function HoldersPage() {
  const [holders, setHolders] = useState<Holder[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (q: string) => {
    try {
      setHolders(await apiFetch<Holder[]>(`/api/holders?q=${encodeURIComponent(q)}`));
      setError("");
    } catch (err) {
      setError(message(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    apiFetch<Permission[]>("/api/permissions").then(setPermissions, (err) => setError(message(err)));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(query), 250);
    return () => clearTimeout(t);
  }, [query, load]);

  async function save(payload: HolderPayload) {
    const holder = editing?.holder;
    try {
      await apiFetch(holder ? `/api/holders/${holder.holder_id}` : "/api/holders", {
        method: holder ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setEditing(null);
      await load(query);
    } catch (err) {
      setError(message(err));
    }
  }

  async function remove(h: Holder) {
    if (!confirm(deleteHolderMessage(h))) return;
    try {
      await apiFetch(`/api/holders/${h.holder_id}`, { method: "DELETE" });
      setError("");
      await load(query);
    } catch (err) {
      setError(message(err));
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
                <td colSpan={6} className="px-4 py-6 text-center text-muted">
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
