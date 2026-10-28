"use client";

import { useState, useTransition } from "react";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";

interface Props {
  holders: { id: string; name: string }[];
  /** Titulares que ya tienen el perfil. */
  assigned: string[];
  onSave: (holderIds: string[]) => Promise<ActionResult>;
}

/** Titulares del perfil: lista con casillas y filtro de texto (la selección se conserva al filtrar). */
export default function ProfileHoldersPicker({ holders, assigned, onSave }: Props) {
  const [selected, setSelected] = useState(() => new Set(assigned));
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();

  const q = query.trim().toLowerCase();
  const visibles = q ? holders.filter((h) => h.name.toLowerCase().includes(q)) : holders;

  function alternar(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function guardar() {
    setNotice(null);
    startTransition(async () => {
      const r = await onSave([...selected]);
      setNotice(r.ok ? { kind: "ok", text: "Se guardaron los titulares." } : { kind: "error", text: r.error });
    });
  }

  return (
    <div className="grid gap-3">
      <label className="block max-w-sm text-sm font-medium">
        Buscar titular
        <input className="field" type="search" value={query} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p className="text-sm text-muted">
        {selected.size === 1 ? "1 titular seleccionado" : `${selected.size} titulares seleccionados`}
      </p>
      <ul className="max-h-72 overflow-y-auto rounded-lg border border-line bg-surface">
        {visibles.map((h) => (
          <li key={h.id} className="border-b border-line last:border-0">
            <label className="flex items-center gap-3 px-3 py-2 text-sm">
              <input type="checkbox" checked={selected.has(h.id)} onChange={() => alternar(h.id)} />
              <span className="[overflow-wrap:anywhere]">{h.name}</span>
            </label>
          </li>
        ))}
        {visibles.length === 0 && (
          <li className="px-3 py-4 text-center text-sm text-muted">
            {holders.length === 0 ? "Aún no hay titulares." : "Ningún titular coincide con la búsqueda."}
          </li>
        )}
      </ul>
      <Notices notice={notice} />
      <div>
        <button type="button" className="btn" disabled={pendiente} onClick={guardar}>
          {pendiente ? "Guardando…" : "Guardar titulares"}
        </button>
      </div>
    </div>
  );
}
