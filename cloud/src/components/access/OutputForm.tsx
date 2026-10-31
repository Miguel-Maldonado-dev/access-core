"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import Notices, { type Notice } from "@/components/Notices";
import { outputLabel } from "@/lib/access-view";
import type { ActionResult } from "@/lib/actions";
import type { OutputInput, OutputRow } from "@/lib/outputs";
import type { CommandStatus } from "@/lib/panel-commands";
import { DURATION_MESSAGE, OUTPUT_MAX_MS, READER_COUNT, fromMask, readerLabel, toMask } from "@/lib/profile-view";

interface Props {
  /** Nombre del panel, para distinguir los formularios de la página. */
  panelCode: string;
  output: OutputRow;
  onSave: (outputId: string, input: OutputInput) => Promise<ActionResult>;
  /** "Probar": manda al panel la orden de activar esta salida. Sin ella no hay botón. */
  onTest?: () => Promise<ActionResult<{ commandId: string }>>;
  /** Estado de la orden de prueba. */
  onStatus?: (commandId: string) => Promise<ActionResult<{ status: CommandStatus; detail: string | null }>>;
}

/** Cada cuánto se consulta el resultado de la prueba. */
const CONSULTA_MS = 1_000;
/** Espera máxima del resultado; la orden vence en la nube a los 10 s. */
const ESPERA_MS = 8_000;
const SIN_RESPUESTA = "El panel no respondió";
/** Si una acción lanza en vez de devolver un ActionResult (red o base de datos). */
const FALLO_INESPERADO = "No se pudo consultar el panel. Intenta de nuevo.";

const esperar = (ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms));

/** Una salida: alias, duración del pulso, lectores que la abren y si está habilitada; y "Probar". */
export default function OutputForm({ panelCode, output, onSave, onTest, onStatus }: Props) {
  const [alias, setAlias] = useState(output.alias);
  const [duration, setDuration] = useState(String(output.duration_ms));
  const [readers, setReaders] = useState(fromMask(output.reader_mask, READER_COUNT));
  const [enabled, setEnabled] = useState(output.enabled);
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();
  // Estado propio y no `useTransition`: React entrelaza las transiciones asíncronas en curso
  // y la espera de la prueba (hasta 8 s) dejaría "Guardando…" en las demás salidas.
  const [probando, setProbando] = useState(false);
  const name = outputLabel(output.output_index);
  // Si se sale de la página a media espera, deja de consultar.
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

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

  async function probar() {
    setNotice(null);
    setProbando(true);
    try {
      const aviso = await esperarPrueba();
      if (aviso && montado.current) setNotice(aviso);
    } catch {
      if (montado.current) setNotice({ kind: "error", text: FALLO_INESPERADO });
    } finally {
      if (montado.current) setProbando(false);
    }
  }

  /** Manda la prueba y consulta su resultado cada 1 s, hasta 8 s; null si se salió de la página. */
  async function esperarPrueba(): Promise<Notice> {
    if (!onTest || !onStatus) return null;
    const r = await onTest();
    if (!r.ok) return { kind: "error", text: r.error };
    const fin = Date.now() + ESPERA_MS;
    while (Date.now() < fin) {
      await esperar(Math.min(CONSULTA_MS, fin - Date.now()));
      if (!montado.current) return null;
      const estado = await onStatus(r.data.commandId);
      if (!estado.ok) return { kind: "error", text: estado.error };
      const { status, detail } = estado.data;
      if (status === "ok") return { kind: "ok", text: "Salida activada" };
      if (status === "error") return { kind: "error", text: detail ?? "El panel no pudo activar la salida." };
      if (status === "expired") break;
    }
    return { kind: "error", text: SIN_RESPUESTA };
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
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn" disabled={pendiente}>
          {pendiente ? "Guardando…" : `Guardar ${name}`}
        </button>
        {onTest && onStatus && (
          <button type="button" className="btn-quiet" onClick={probar} disabled={probando}>
            {probando ? "Probando…" : `Probar ${name}`}
          </button>
        )}
      </div>
    </form>
  );
}
