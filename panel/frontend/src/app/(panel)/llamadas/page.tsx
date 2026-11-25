"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api";
import { fromMask, toMask } from "@/lib/masks";
import { errorMessage, useApiResource } from "@/lib/useApiList";
import { CALLS_CHANGED_EVENT, DISABLE_CONFIRM } from "@/lib/calls";
import type { CallMode, CallSettings, GsmStatus, Output } from "@/lib/types";

const NO_OUTPUTS: Output[] = [];
const LIMIT_MESSAGE = "Debe ser un número entre 1 y 20.";

function outputName(o: Output): string {
  const short = `S${o.output_id + 1}`;
  return o.alias.trim() === "" ? short : `${short} · ${o.alias.trim()}`;
}

function Status() {
  const [status, setStatus] = useState<GsmStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    apiFetch<GsmStatus>("/api/calls/status").then(
      (s) => !ignore && setStatus(s),
      (err) => !ignore && setError(errorMessage(err)),
    );
    return () => {
      ignore = true;
    };
  }, []);

  const noData = <span className="text-muted">Sin dato</span>;
  return (
    <section className="panel" aria-label="Estado del módulo">
      <h2 className="mb-3 text-lg font-semibold">Estado del módulo</h2>
      {error !== "" ? (
        <p className="text-sm text-muted">{error}</p>
      ) : status === null ? (
        <p className="text-sm text-muted">Consultando…</p>
      ) : (
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="font-medium">Puerto</dt>
          <dd className="tabular-nums">{status.port ?? noData}</dd>
          <dt className="font-medium">Registrado en la red</dt>
          <dd>{status.registered === null ? noData : status.registered ? "Sí" : "No"}</dd>
          <dt className="font-medium">Señal</dt>
          <dd className="tabular-nums">{status.signal === null ? noData : `${status.signal}/31`}</dd>
        </dl>
      )}
    </section>
  );
}

function Form({ initial, outputs }: { initial: CallSettings; outputs: Output[] }) {
  // Estado guardado en el servidor: decide si hay que confirmar la desactivación.
  const [savedEnabled, setSavedEnabled] = useState(initial.enabled);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState<CallMode>(initial.mode);
  const [outputId, setOutputId] = useState(String(initial.output_id));
  const [menu, setMenu] = useState(fromMask(initial.menu_mask, 4));
  const [defaultOutput, setDefaultOutput] = useState(initial.default_output === null ? "" : String(initial.default_output));
  const [limit, setLimit] = useState(String(initial.call_limit_per_minute));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const names = [0, 1, 2, 3].map((i) => {
    const o = outputs.find((x) => x.output_id === i);
    return o ? outputName(o) : `S${i + 1}`;
  });

  function toggle(i: number) {
    const next = menu.map((v, j) => (j === i ? !v : v));
    setMenu(next);
    if (!next[i] && defaultOutput === String(i)) setDefaultOutput("");
    setSaved(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const perMinute = Number(limit);
    if (limit.trim() === "" || !Number.isInteger(perMinute) || perMinute < 1 || perMinute > 20) {
      setSaved(false);
      setError(LIMIT_MESSAGE);
      return;
    }
    const body: CallSettings = {
      enabled,
      mode,
      output_id: Number(outputId),
      menu_mask: toMask(menu),
      default_output: mode === "menu" && defaultOutput !== "" ? Number(defaultOutput) : null,
      call_limit_per_minute: perMinute,
    };
    if (savedEnabled && !enabled && !confirm(DISABLE_CONFIRM)) return;
    try {
      const stored = await apiFetch<CallSettings>("/api/calls/settings", { method: "PUT", body: JSON.stringify(body) });
      setSavedEnabled(stored.enabled);
      setError("");
      setSaved(true);
      window.dispatchEvent(new Event(CALLS_CHANGED_EVENT));
    } catch (err) {
      setSaved(false);
      setError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="panel grid gap-5" onChange={() => setSaved(false)}>
      {error !== "" && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Activar módulo
        </label>
        <p className="mt-1 text-sm text-muted">
          Al desactivarlo se borran los teléfonos registrados en este panel.
        </p>
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Al recibir una llamada</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="mode" checked={mode === "single"} onChange={() => setMode("single")} />
            Una salida
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="mode" checked={mode === "menu"} onChange={() => setMode("menu")} />
            Varias salidas
          </label>
        </div>
        <p className="mt-1 text-sm text-muted">
          {mode === "single"
            ? "Rechaza la llamada y abre la salida elegida, sin contestar."
            : "Contesta y abre la salida de la tecla 1 a 4 que se presione."}
        </p>
      </fieldset>

      {mode === "single" ? (
        <label className="max-w-sm text-sm font-medium">
          Salida
          <select className="field" value={outputId} onChange={(e) => setOutputId(e.target.value)}>
            {names.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <fieldset>
            <legend className="text-sm font-medium">Salidas del menú</legend>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {names.map((n, i) => (
                <label key={i} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={menu[i]} onChange={() => toggle(i)} />
                  {n}
                </label>
              ))}
            </div>
            <p className="mt-1 text-sm text-muted">La tecla n abre la salida Sn si está marcada aquí.</p>
          </fieldset>
          <div className="max-w-sm">
            <label className="text-sm font-medium">
              Salida predeterminada
              <select className="field" value={defaultOutput} onChange={(e) => setDefaultOutput(e.target.value)}>
                <option value="">Ninguna</option>
                {names.map((n, i) => (menu[i] ? <option key={n} value={i}>{n}</option> : null))}
              </select>
            </label>
            <p className="mt-1 text-sm text-muted">Se abre si pasan 8 segundos sin presionar una tecla válida.</p>
          </div>
        </>
      )}

      <label className="max-w-sm text-sm font-medium">
        Aperturas por minuto por número
        <input
          className="field tabular-nums"
          type="number"
          inputMode="numeric"
          min={1}
          max={20}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
      </label>

      <div className="flex items-center gap-4">
        <button type="submit" className="btn">
          Guardar
        </button>
        {saved && (
          <p role="status" className="text-sm font-medium text-signal">
            Configuración guardada
          </p>
        )}
      </div>
    </form>
  );
}

export default function CallsPage() {
  const settings = useApiResource<CallSettings | null>("/api/calls/settings", null);
  const outputs = useApiResource<Output[]>("/api/outputs", NO_OUTPUTS);
  const error = settings.error || outputs.error;
  const ready = settings.data !== null && outputs.loaded;

  return (
    <div className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold">Llamadas</h1>
      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {ready && <Form initial={settings.data!} outputs={outputs.data} />}
      <Status />
    </div>
  );
}
