"use client";

import { useState, type FormEvent } from "react";
import { BUTTON_COUNT, OUTPUT_COUNT, outputLabel, parseCode } from "@/lib/access-view";
import type { ButtonInput, ControlInput, ControlRow } from "@/lib/controls";

interface Props {
  control?: ControlRow;
  holders: { id: string; name: string }[];
  error?: string;
  pending?: boolean;
  onSubmit: (input: ControlInput) => void;
  onCancel: () => void;
}

const POSICIONES = Array.from({ length: BUTTON_COUNT }, (_, i) => i);
const SALIDAS = Array.from({ length: OUTPUT_COUNT }, (_, i) => i);

export default function ControlForm({ control, holders, error = "", pending = false, onSubmit, onCancel }: Props) {
  const [holderId, setHolderId] = useState(control?.holder_id ?? "");
  const [description, setDescription] = useState(control?.description ?? "");
  const [codes, setCodes] = useState<string[]>(() =>
    POSICIONES.map((i) => {
      const b = control?.buttons.find((x) => x.button === i);
      return b ? String(b.rf_code) : "";
    }),
  );
  // Un control nuevo propone que el botón N abra la salida N; al editar se respeta lo guardado.
  const [outputs, setOutputs] = useState<string[]>(() =>
    POSICIONES.map((i) => {
      if (!control) return String(i);
      const o = control.buttons.find((x) => x.button === i)?.output_index;
      return o === null || o === undefined ? "" : String(o);
    }),
  );
  const [localError, setLocalError] = useState("");

  const poner = (setter: typeof setCodes, i: number, valor: string) =>
    setter((cur) => cur.map((v, j) => (j === i ? valor : v)));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (holderId === "") return setLocalError("Elige un titular.");
    const buttons: ButtonInput[] = [];
    for (const i of POSICIONES) {
      if (codes[i].trim() === "") {
        buttons.push({ rf_code: null, output_index: null });
        continue;
      }
      try {
        buttons.push({ rf_code: parseCode(codes[i]), output_index: outputs[i] === "" ? null : Number(outputs[i]) });
      } catch (err) {
        return setLocalError(`Botón ${i + 1}: ${(err as Error).message}`);
      }
    }
    setLocalError("");
    onSubmit({ holder_id: holderId, description: description.trim(), buttons });
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
        Titular
        <select className="field" value={holderId} onChange={(e) => setHolderId(e.target.value)}>
          <option value="">Elige un titular</option>
          {holders.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium">
        Descripción
        <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} autoComplete="off" />
      </label>
      <fieldset className="grid gap-3 sm:col-span-2">
        <legend className="text-sm font-medium">Botones</legend>
        <p className="text-sm text-muted">Un botón sin código se ignora. Los códigos van en decimal.</p>
        {POSICIONES.map((i) => (
          <div key={i} className="grid items-end gap-3 sm:grid-cols-[5rem_1fr_12rem]">
            <span className="text-sm font-medium sm:pb-2">Botón {i + 1}</span>
            <input
              className="field tabular-nums"
              inputMode="numeric"
              autoComplete="off"
              placeholder="Código RF (decimal)"
              aria-label={`Código del botón ${i + 1}`}
              value={codes[i]}
              onChange={(e) => poner(setCodes, i, e.target.value)}
            />
            <select
              className="field"
              aria-label={`Salida del botón ${i + 1}`}
              value={outputs[i]}
              onChange={(e) => poner(setOutputs, i, e.target.value)}
            >
              <option value="">{outputLabel(null)}</option>
              {SALIDAS.map((o) => (
                <option key={o} value={o}>
                  {outputLabel(o)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </fieldset>
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
