"use client";

import { useState, useTransition, type FormEvent } from "react";
import Notices, { type Notice } from "@/components/Notices";
import { outputLabel } from "@/lib/access-view";
import type { ActionResult } from "@/lib/actions";
import type { OutputInput, OutputRow } from "@/lib/outputs";
import { DURATION_MESSAGE, OUTPUT_MAX_MS, READER_COUNT, fromMask, readerLabel, toMask } from "@/lib/profile-view";

interface Props {
  /** Nombre del panel, para distinguir los formularios de la página. */
  panelCode: string;
  output: OutputRow;
  onSave: (outputId: string, input: OutputInput) => Promise<ActionResult>;
}

/** Una salida: alias, duración del pulso, lectores que la abren y si está habilitada. */
export default function OutputForm({ panelCode, output, onSave }: Props) {
  const [alias, setAlias] = useState(output.alias);
  const [duration, setDuration] = useState(String(output.duration_ms));
  const [readers, setReaders] = useState(fromMask(output.reader_mask, READER_COUNT));
  const [enabled, setEnabled] = useState(output.enabled);
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();
  const name = outputLabel(output.output_index);

  function submit(e: FormEvent) {
    e.preventDefault();
    const ms = Number(duration);
    if (duration.trim() === "" || !Number.isInteger(ms) || ms < 0 || ms > OUTPUT_MAX_MS) {
      return setNotice({ kind: "error", text: DURATION_MESSAGE });
    }
    setNotice(null);
    startTransition(async () => {
      const r = await onSave(output.id, { alias: alias.trim(), duration_ms: ms, reader_mask: toMask(readers), enabled });
      setNotice(r.ok ? { kind: "ok", text: `Se guardó ${name}.` } : { kind: "error", text: r.error });
    });
  }

  return (
    <form onSubmit={submit} noValidate className="panel grid gap-4" aria-label={`${panelCode} ${name}`}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-base font-semibold">{name}</h4>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Habilitada
        </label>
      </div>
      <label className="text-sm font-medium">
        Alias
        <input
          className="field"
          value={alias}
          maxLength={60}
          placeholder="Ej. Pluma vehicular"
          autoComplete="off"
          onChange={(e) => setAlias(e.target.value)}
        />
      </label>
      <label className="text-sm font-medium">
        Duración del pulso (ms)
        <input
          className="field tabular-nums"
          type="number"
          min={0}
          max={OUTPUT_MAX_MS}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
      </label>
      <fieldset>
        <legend className="text-sm font-medium">Lectores que la abren</legend>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {readers.map((on, i) => (
            <label key={i} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={on}
                onChange={() => setReaders(readers.map((v, j) => (j === i ? !v : v)))}
              />
              {readerLabel(i)}
            </label>
          ))}
        </div>
      </fieldset>
      <Notices notice={notice} />
      <div>
        <button type="submit" className="btn" disabled={pendiente}>
          {pendiente ? "Guardando…" : `Guardar ${name}`}
        </button>
      </div>
    </form>
  );
}
