"use client";

import { useState, type FormEvent } from "react";
import { fromMask, toMask } from "@/lib/masks";
import { outputLabel } from "@/lib/format";
import type { Output } from "@/lib/types";

export interface OutputPayload {
  duration_ms: number;
  reader_mask: number;
  enabled: boolean;
}

const READERS = ["Reader1", "Reader2", "Reader3", "Reader4"];

export default function OutputForm({ output, onSubmit }: {
  output: Output;
  onSubmit: (payload: OutputPayload) => void | Promise<void>;
}) {
  const [duration, setDuration] = useState(String(output.duration_ms));
  const [readers, setReaders] = useState(fromMask(output.reader_mask, 4));
  const [enabled, setEnabled] = useState(output.enabled);
  const [error, setError] = useState("");
  const name = outputLabel(output.output_id);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ms = Number(duration);
    if (duration.trim() === "" || !Number.isInteger(ms) || ms < 0 || ms > 65535) {
      setError("La duración debe ser un número entero de 0 a 65535 ms.");
      return;
    }
    setError("");
    await onSubmit({ duration_ms: ms, reader_mask: toMask(readers), enabled });
  }

  return (
    <form onSubmit={submit} noValidate className="panel grid gap-4" aria-label={name}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{name}</h2>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Habilitada
        </label>
      </div>
      {error !== "" && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <label className="text-sm font-medium">
        Duración del pulso (ms)
        <input className="field" type="number" min={0} max={65535} value={duration} onChange={(e) => setDuration(e.target.value)} />
      </label>
      <fieldset>
        <legend className="text-sm font-medium">Lectores que la abren</legend>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {READERS.map((label, i) => (
            <label key={label} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={readers[i]}
                onChange={() => setReaders(readers.map((v, j) => (j === i ? !v : v)))}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <button type="submit" className="btn">
          Guardar {name}
        </button>
      </div>
    </form>
  );
}
