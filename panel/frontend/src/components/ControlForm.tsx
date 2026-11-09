"use client";

import { useState, type FormEvent } from "react";
import { listenRf } from "@/lib/api";
import { parseCode } from "@/lib/codes";
import { outputLabel } from "@/lib/format";
import type { Control, ControlButton, Holder, ListenResult } from "@/lib/types";

export interface ControlPayload {
  holder_id: number;
  description: string;
  buttons: ControlButton[];
}

interface Props {
  control?: Control;
  holders: Holder[];
  error?: string;
  onSubmit: (payload: ControlPayload) => void | Promise<void>;
  onCancel?: () => void;
  onListen?: () => Promise<ListenResult>;
}

const OUTPUTS = [0, 1, 2, 3];

export default function ControlForm({ control, holders, error = "", onSubmit, onCancel, onListen = listenRf }: Props) {
  const [holderId, setHolderId] = useState(control ? String(control.holder_id) : "");
  const [description, setDescription] = useState(control?.description ?? "");
  const [codes, setCodes] = useState<string[]>(() =>
    OUTPUTS.map((i) => {
      const code = control?.buttons[i]?.rf_code;
      return code === null || code === undefined ? "" : String(code);
    }),
  );
  const [outputs, setOutputs] = useState<string[]>(() =>
    OUTPUTS.map((i) => {
      if (!control) return String(i);
      const out = control.buttons[i]?.output_id;
      return out === null || out === undefined ? "" : String(out);
    }),
  );
  const [localError, setLocalError] = useState("");
  // Fila que está escuchando (solo una a la vez) y avisos por fila.
  const [listening, setListening] = useState<number | null>(null);
  const [notes, setNotes] = useState<string[]>(() => OUTPUTS.map(() => ""));

  async function listen(i: number) {
    setListening(i);
    setAt(setNotes, i, "");
    try {
      const res = await onListen();
      if (res.code === null) {
        setAt(setNotes, i, "No se recibió ningún control.");
      } else if (res.control && res.control.control_id !== control?.control_id) {
        const who = res.control.description ? res.control.description : "otro control";
        setAt(setNotes, i, `Este código ya pertenece a ${who}`);
      } else {
        setAt(setCodes, i, String(res.code));
      }
    } catch (err) {
      setAt(setNotes, i, (err as Error).message);
    } finally {
      setListening(null);
    }
  }

  function setAt(setter: typeof setCodes, i: number, value: string) {
    setter((cur) => cur.map((v, j) => (j === i ? value : v)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (holderId === "") {
      setLocalError("Elige un titular.");
      return;
    }
    const buttons: ControlButton[] = [];
    for (const i of OUTPUTS) {
      if (codes[i].trim() === "") {
        buttons.push({ rf_code: null, output_id: null });
        continue;
      }
      try {
        buttons.push({ rf_code: parseCode(codes[i]), output_id: outputs[i] === "" ? null : Number(outputs[i]) });
      } catch (err) {
        setLocalError(`Botón ${i + 1}: ${(err as Error).message}`);
        return;
      }
    }
    setLocalError("");
    await onSubmit({ holder_id: Number(holderId), description: description.trim(), buttons });
  }

  const shown = localError || error;

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      {shown !== "" && (
        <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">
          {shown}
        </p>
      )}
      <label className="text-sm font-medium">
        Titular
        <select className="field" value={holderId} onChange={(e) => setHolderId(e.target.value)}>
          <option value="">Elige un titular</option>
          {holders.map((h) => (
            <option key={h.holder_id} value={h.holder_id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium">
        Descripción
        <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <fieldset className="grid gap-3 sm:col-span-2">
        <legend className="text-sm font-medium">Botones</legend>
        <p className="text-sm text-muted">Un botón sin código se ignora.</p>
        {OUTPUTS.map((i) => (
          <div key={i} className="grid items-end gap-3 sm:grid-cols-[5rem_1fr_auto_12rem]">
            <span className="pb-2 text-sm font-medium">Botón {i + 1}</span>
            <label className="text-sm">
              <span className="sr-only">Código del botón {i + 1}</span>
              <input
                className="field tabular-nums"
                inputMode="numeric"
                placeholder="Código RF (decimal)"
                aria-label={`Código del botón ${i + 1}`}
                value={codes[i]}
                onChange={(e) => setAt(setCodes, i, e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn-quiet"
              disabled={listening !== null}
              aria-label={listening === i ? "Escuchando…" : `Escuchar código del botón ${i + 1}`}
              onClick={() => listen(i)}
            >
              {listening === i ? "Escuchando…" : "Escuchar"}
            </button>
            <select
              className="field"
              aria-label={`Salida del botón ${i + 1}`}
              value={outputs[i]}
              onChange={(e) => setAt(setOutputs, i, e.target.value)}
            >
              <option value="">Sin asignar</option>
              {OUTPUTS.map((o) => (
                <option key={o} value={o}>
                  {outputLabel(o)}
                </option>
              ))}
            </select>
            <p aria-live="polite" className="min-h-5 text-sm font-medium text-danger sm:col-span-4">
              {notes[i]}
            </p>
          </div>
        ))}
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
