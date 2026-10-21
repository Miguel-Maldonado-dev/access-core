"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api";
import type { Holder, HolderKind, Permission } from "@/lib/types";

export interface HolderPayload {
  kind: HolderKind;
  name: string;
  department: string;
  address: string;
  notes: string;
  pin: string | null;
  permission_ids: number[];
}

interface Props {
  holder?: Holder;
  permissions: Permission[];
  onSubmit: (payload: HolderPayload) => void | Promise<void>;
  onCancel?: () => void;
}

export default function HolderForm({ holder, permissions, onSubmit, onCancel }: Props) {
  const [kind, setKind] = useState<HolderKind>(holder?.kind ?? "persona");
  const [name, setName] = useState(holder?.name ?? "");
  const [department, setDepartment] = useState(holder?.department ?? "");
  const [address, setAddress] = useState(holder?.address ?? "");
  const [notes, setNotes] = useState(holder?.notes ?? "");
  const [selected, setSelected] = useState<number[]>(holder?.permission_ids ?? []);
  const [pin, setPin] = useState(holder?.pin ?? "");
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState("");

  function toggle(id: number) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function generatePin() {
    try {
      const res = await apiFetch<{ pin: string }>("/api/holders/generate-pin", { method: "POST" });
      setPin(res.pin);
      setShowPin(true);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el PIN.");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === "") {
      setError("El nombre es obligatorio.");
      return;
    }
    if (pin !== "" && pin.length < 4) {
      setError("El PIN debe tener de 4 a 6 dígitos.");
      return;
    }
    setError("");
    await onSubmit({
      kind,
      name: name.trim(),
      department: department.trim(),
      address: address.trim(),
      notes: notes.trim(),
      pin: pin === "" ? null : pin,
      permission_ids: [...selected].sort((a, b) => a - b),
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      {error !== "" && (
        <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">
          {error}
        </p>
      )}
      <label className="text-sm font-medium">
        Nombre
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="text-sm font-medium">
        Tipo
        <select className="field" value={kind} onChange={(e) => setKind(e.target.value as HolderKind)}>
          <option value="persona">Persona</option>
          <option value="domicilio">Domicilio</option>
        </select>
      </label>
      <label className="text-sm font-medium">
        Departamento
        <input className="field" value={department} onChange={(e) => setDepartment(e.target.value)} />
      </label>
      <label className="text-sm font-medium">
        Dirección
        <input className="field" value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      <label className="text-sm font-medium sm:col-span-2">
        Notas
        <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="sm:col-span-2">
        <label htmlFor="holder-pin" className="text-sm font-medium">
          PIN
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <input
            id="holder-pin"
            className={`field max-w-40${showPin ? "" : " pin-masked"}`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          <button type="button" className="btn-quiet" onClick={() => void generatePin()}>
            Generar
          </button>
          <button type="button" className="btn-quiet" onClick={() => setShowPin((s) => !s)}>
            {showPin ? "Ocultar PIN" : "Mostrar PIN"}
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">De 4 a 6 dígitos, único por titular. Déjalo vacío para no usar PIN.</p>
      </div>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium">Permisos</legend>
        {permissions.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Aún no hay permisos. Créalos en la sección Permisos.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {permissions.map((p) => (
              <label key={p.permission_id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(p.permission_id)}
                  onChange={() => toggle(p.permission_id)}
                />
                {p.permission_id} · {p.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex gap-3 sm:col-span-2">
        <button type="submit" className="btn">
          Guardar
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
