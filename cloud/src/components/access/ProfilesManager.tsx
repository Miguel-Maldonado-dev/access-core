"use client";

import { useState, useTransition, type FormEvent } from "react";
import ProfileHoldersPicker from "@/components/access/ProfileHoldersPicker";
import ProfileRulesEditor from "@/components/access/ProfileRulesEditor";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import type { OutputRow } from "@/lib/outputs";
import { MAX_PROFILES, NAME_MAX, type PanelOption, type PanelRuleInput } from "@/lib/profile-view";
import type { ProfileRow } from "@/lib/profiles";

interface Props {
  profiles: ProfileRow[];
  holders: { id: string; name: string }[];
  panels: PanelOption[];
  outputs: OutputRow[];
  onCreate: (name: string) => Promise<ActionResult<{ id: string }>>;
  onRename: (profileId: string, name: string) => Promise<ActionResult>;
  onDelete: (profileId: string) => Promise<ActionResult>;
  onSaveRules: (profileId: string, rules: PanelRuleInput[]) => Promise<ActionResult>;
  onSetHolders: (profileId: string, holderIds: string[]) => Promise<ActionResult>;
}

/** Nombre del perfil: alta en la lista y cambio de nombre al editar. */
function NameForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: string;
  submitLabel: string;
  pending: boolean;
  error: string;
  onSubmit: (name: string) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial);
  const [localError, setLocalError] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === "") return setLocalError("Escribe el nombre del perfil.");
    setLocalError("");
    onSubmit(name.trim());
  }

  const mostrado = localError || error;
  return (
    <form onSubmit={submit} noValidate className="grid gap-3">
      {mostrado !== "" && (
        <p role="alert" className="notice-error">
          {mostrado}
        </p>
      )}
      <label className="max-w-md text-sm font-medium">
        Nombre del perfil
        <input
          className="field"
          value={name}
          maxLength={NAME_MAX}
          placeholder="Ej. Residente"
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="flex gap-3">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Guardando…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn-quiet" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Pestaña Perfiles: alta, nombre y borrado; al editar un perfil se ven sus reglas por panel
 * y los titulares que lo tienen. El número de permiso (P0–P31) lo asigna la nube.
 */
export default function ProfilesManager({
  profiles,
  holders,
  panels,
  outputs,
  onCreate,
  onRename,
  onDelete,
  onSaveRules,
  onSetHolders,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [pendiente, startTransition] = useTransition();

  const editing = profiles.find((p) => p.id === editingId) ?? null;
  const lleno = profiles.length >= MAX_PROFILES;

  function crear(name: string) {
    setFormError("");
    startTransition(async () => {
      const r = await onCreate(name);
      if (!r.ok) return setFormError(r.error);
      setCreating(false);
      setEditingId(r.data.id);
      setNotice({ kind: "ok", text: `Se creó el perfil ${name}. Define sus reglas por panel.` });
    });
  }

  function renombrar(profile: ProfileRow, name: string) {
    setFormError("");
    startTransition(async () => {
      const r = await onRename(profile.id, name);
      if (!r.ok) return setFormError(r.error);
      setNotice({ kind: "ok", text: `Se guardó el nombre ${name}.` });
    });
  }

  function borrar(p: ProfileRow) {
    const titulares =
      p.holder_ids.length === 0
        ? ""
        : ` Lo perderán ${p.holder_ids.length === 1 ? "1 titular" : `${p.holder_ids.length} titulares`}.`;
    if (!window.confirm(`¿Borrar el perfil "${p.name}"? Se borrarán también sus reglas.${titulares}`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onDelete(p.id);
      if (r.ok && editingId === p.id) setEditingId(null);
      setNotice(r.ok ? { kind: "ok", text: `Se borró el perfil ${p.name}.` } : { kind: "error", text: r.error });
    });
  }

  function abrir(id: string | null, nuevo = false) {
    setNotice(null);
    setFormError("");
    setCreating(nuevo);
    setEditingId(id);
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Perfiles de acceso</h2>
        <button type="button" className="btn" disabled={lleno} onClick={() => abrir(null, true)}>
          Nuevo perfil
        </button>
      </div>
      {lleno && <p className="text-sm text-muted">Máximo {MAX_PROFILES} perfiles por instalación.</p>}

      {creating && (
        <section className="panel" aria-labelledby="perfil-nuevo">
          <h3 id="perfil-nuevo" className="mb-4 text-lg font-semibold">
            Nuevo perfil
          </h3>
          <NameForm
            initial=""
            submitLabel="Crear perfil"
            pending={pendiente}
            error={formError}
            onSubmit={crear}
            onCancel={() => setCreating(false)}
          />
        </section>
      )}

      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Permiso</th>
                <th scope="col" className="px-4 py-2 font-medium">Perfil</th>
                <th scope="col" className="px-4 py-2 font-medium">Titulares</th>
                <th scope="col" className="px-4 py-2 font-medium">Paneles con regla</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3 tabular-nums">{p.local_permission_id}</td>
                  <th scope="row" className="px-4 py-3 font-medium [overflow-wrap:anywhere]">{p.name}</th>
                  <td className="px-4 py-3 tabular-nums">{p.holder_ids.length}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {p.rules.filter((r) => panels.some((x) => x.id === r.panel_id)).length} de {panels.length}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-4 whitespace-nowrap">
                      <button type="button" className="link-action" disabled={pendiente} onClick={() => abrir(p.id)}>
                        Editar <span className="sr-only">el perfil {p.name}</span>
                      </button>
                      <button type="button" className="link-danger" disabled={pendiente} onClick={() => borrar(p)}>
                        Borrar <span className="sr-only">el perfil {p.name}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {profiles.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted">
                    Aún no hay perfiles. Crea el primero con Nuevo perfil.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <section className="panel grid gap-8" aria-labelledby="perfil-editar">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="perfil-editar" className="text-lg font-semibold [overflow-wrap:anywhere]">
              Editar perfil {editing.name}
            </h3>
            <button type="button" className="btn-quiet" onClick={() => abrir(null)}>
              Cerrar
            </button>
          </div>
          <div className="grid gap-3">
            <h4 className="font-semibold">Nombre</h4>
            <NameForm
              key={`${editing.id}:${editing.name}`}
              initial={editing.name}
              submitLabel="Guardar nombre"
              pending={pendiente}
              error={creating ? "" : formError}
              onSubmit={(name) => renombrar(editing, name)}
            />
          </div>
          <div className="grid gap-3">
            <h4 className="font-semibold">Reglas por panel</h4>
            <ProfileRulesEditor
              key={editing.id}
              panels={panels}
              rules={editing.rules}
              outputs={outputs}
              onSave={(rules) => onSaveRules(editing.id, rules)}
            />
          </div>
          <div className="grid gap-3">
            <h4 className="font-semibold">Titulares con este perfil</h4>
            <ProfileHoldersPicker
              key={editing.id}
              holders={holders}
              assigned={editing.holder_ids}
              onSave={(ids) => onSetHolders(editing.id, ids)}
            />
          </div>
        </section>
      )}
    </div>
  );
}
