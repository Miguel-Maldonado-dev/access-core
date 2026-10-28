"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import type { Installation } from "@/lib/installations";

interface Props {
  tenantId: string;
  installations: Installation[];
  /** Solo el `admin` del tenant crea instalaciones. */
  canCreate: boolean;
  onCreate: (tenantId: string, name: string) => Promise<ActionResult<{ id: string }>>;
  onRename: (tenantId: string, installationId: string, name: string) => Promise<ActionResult>;
}

/** /t/[tenant]/installations: lista con alta (admin) y cambio de nombre (cualquier miembro). */
export default function InstallationsManager({ tenantId, installations, canCreate, onCreate, onRename }: Props) {
  const [notice, setNotice] = useState<Notice>(null);

  return (
    <div className="grid grid-cols-1 gap-6">
      {canCreate && <CreateForm tenantId={tenantId} onCreate={onCreate} onNotice={setNotice} />}
      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        {installations.length === 0 ? (
          <p className="panel text-muted">
            {canCreate
              ? "Este tenant aún no tiene instalaciones. Crea la primera con el formulario de arriba."
              : "Este tenant aún no tiene instalaciones. Un administrador puede crear la primera."}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {installations.map((i) => (
              <InstallationRow key={i.id} tenantId={tenantId} installation={i} onRename={onRename} onNotice={setNotice} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function InstallationRow({
  tenantId,
  installation,
  onRename,
  onNotice,
}: {
  tenantId: string;
  installation: Installation;
  onRename: Props["onRename"];
  onNotice: (notice: Notice) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [nombre, setNombre] = useState(installation.name);
  const [pendiente, startTransition] = useTransition();

  function guardar(e: FormEvent) {
    e.preventDefault();
    onNotice(null);
    startTransition(async () => {
      const r = await onRename(tenantId, installation.id, nombre);
      if (!r.ok) {
        onNotice({ kind: "error", text: r.error });
        return;
      }
      onNotice({ kind: "ok", text: `La instalación ahora se llama ${nombre.trim()}.` });
      setEditando(false);
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
      {editando ? (
        <form onSubmit={guardar} noValidate className="flex flex-1 flex-wrap items-end gap-3">
          <label className="block min-w-48 flex-1 text-sm font-medium">
            <span className="sr-only">Nuevo nombre de {installation.name}</span>
            <input
              className="field mt-0"
              aria-label={`Nuevo nombre de ${installation.name}`}
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              autoFocus
              required
            />
          </label>
          <button type="submit" className="btn" disabled={pendiente}>
            Guardar
          </button>
          <button
            type="button"
            className="btn-quiet"
            onClick={() => {
              setNombre(installation.name);
              setEditando(false);
            }}
          >
            Cancelar
          </button>
        </form>
      ) : (
        <>
          <Link
            href={`/t/${tenantId}/installations/${installation.id}/paneles`}
            className="font-medium text-signal underline [overflow-wrap:anywhere]"
          >
            {installation.name}
          </Link>
          <button type="button" className="link-action" onClick={() => setEditando(true)}>
            Renombrar <span className="sr-only">{installation.name}</span>
          </button>
        </>
      )}
    </li>
  );
}

function CreateForm({
  tenantId,
  onCreate,
  onNotice,
}: {
  tenantId: string;
  onCreate: Props["onCreate"];
  onNotice: (notice: Notice) => void;
}) {
  const [nombre, setNombre] = useState("");
  const [pendiente, startTransition] = useTransition();

  function enviar(e: FormEvent) {
    e.preventDefault();
    onNotice(null);
    startTransition(async () => {
      const r = await onCreate(tenantId, nombre);
      if (!r.ok) {
        onNotice({ kind: "error", text: r.error });
        return;
      }
      onNotice({ kind: "ok", text: `Se creó la instalación ${nombre.trim()}.` });
      setNombre("");
    });
  }

  return (
    <form onSubmit={enviar} noValidate className="panel" aria-labelledby="crear-instalacion">
      <h2 id="crear-instalacion" className="text-lg font-semibold">
        Nueva instalación
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="block text-sm font-medium">
          Nombre
          <input
            className="field"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" className="btn" disabled={pendiente}>
          {pendiente ? "Creando…" : "Crear instalación"}
        </button>
      </div>
    </form>
  );
}
