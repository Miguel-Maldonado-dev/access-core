"use client";

import { useState, type FormEvent } from "react";
import { PIN_MESSAGE, holderKindLabel, isValidPin, type HolderKind } from "@/lib/access-view";
import type { HolderInput, HolderRow, PinChange } from "@/lib/holders";

interface Props {
  holder?: HolderRow;
  /** PIN actual: solo lo trae el admin al editar (`null` si el titular no tiene). */
  currentPin?: string | null;
  canSeePin: boolean;
  error?: string;
  pending?: boolean;
  onSubmit: (input: HolderInput) => void;
  onCancel: () => void;
}

/** PIN aleatorio de 6 dígitos; la unicidad la comprueba el servidor al guardar. */
function randomPin(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n % 1_000_000).padStart(6, "0");
}

export default function HolderForm({ holder, currentPin = null, canSeePin, error = "", pending = false, onSubmit, onCancel }: Props) {
  const [kind, setKind] = useState<HolderKind>(holder?.kind ?? "persona");
  const [name, setName] = useState(holder?.name ?? "");
  const [department, setDepartment] = useState(holder?.department ?? "");
  const [address, setAddress] = useState(holder?.address ?? "");
  const [notes, setNotes] = useState(holder?.notes ?? "");
  const [pin, setPin] = useState(currentPin ?? "");
  const [clearPin, setClearPin] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [localError, setLocalError] = useState("");

  // Quien no ve el PIN actual solo puede reemplazarlo o quitarlo.
  const canClear = !canSeePin && holder?.has_pin === true;

  function pinChange(): PinChange {
    if (canSeePin) {
      if (pin === (currentPin ?? "")) return { mode: "keep" };
      return pin === "" ? { mode: "clear" } : { mode: "set", pin };
    }
    if (clearPin) return { mode: "clear" };
    return pin === "" ? { mode: "keep" } : { mode: "set", pin };
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === "") return setLocalError("El nombre es obligatorio.");
    const cambio = pinChange();
    if (cambio.mode === "set" && !isValidPin(cambio.pin)) return setLocalError(PIN_MESSAGE);
    setLocalError("");
    onSubmit({
      kind,
      name: name.trim(),
      department: department.trim(),
      address: address.trim(),
      notes: notes.trim(),
      pin: cambio,
    });
  }

  const mostrado = localError || error;

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      {mostrado !== "" && (
        <p role="alert" className="notice-error sm:col-span-2">
          {mostrado}
        </p>
      )}
      <label className="text-sm font-medium">
        Nombre
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      <label className="text-sm font-medium">
        Tipo
        <select className="field" value={kind} onChange={(e) => setKind(e.target.value as HolderKind)}>
          <option value="persona">{holderKindLabel("persona")}</option>
          <option value="domicilio">{holderKindLabel("domicilio")}</option>
        </select>
      </label>
      <label className="text-sm font-medium">
        Departamento
        <input className="field" value={department} onChange={(e) => setDepartment(e.target.value)} autoComplete="off" />
      </label>
      <label className="text-sm font-medium">
        Dirección
        <input className="field" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" />
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
            className="field max-w-40 tabular-nums"
            type={showPin ? "text" : "password"}
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_MAX}
            disabled={clearPin}
            aria-describedby="holder-pin-ayuda"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))}
          />
          <button type="button" className="btn-quiet" disabled={clearPin} onClick={() => { setPin(randomPin()); setShowPin(true); }}>
            Generar
          </button>
          <button type="button" className="btn-quiet" onClick={() => setShowPin((s) => !s)}>
            {showPin ? "Ocultar PIN" : "Mostrar PIN"}
          </button>
        </div>
        {canClear && (
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={clearPin} onChange={(e) => setClearPin(e.target.checked)} />
            Quitar el PIN
          </label>
        )}
        <p id="holder-pin-ayuda" className="mt-1 text-sm text-muted">
          De 4 a 6 dígitos, único por titular.{" "}
          {canClear
            ? "Este titular tiene PIN. Escribe uno nuevo para reemplazarlo."
            : "Déjalo vacío para no usar PIN."}
        </p>
      </div>
      <div className="flex gap-3 sm:col-span-2">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" className="btn-quiet" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

const PIN_MAX = 6;
