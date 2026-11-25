"use client";

import { useState, useTransition } from "react";
import Notices, { type Notice } from "@/components/Notices";
import { OUTPUT_COUNT, outputLabel, outputOptionLabel } from "@/lib/access-view";
import type { ActionResult } from "@/lib/actions";
import {
  CALL_LIMIT_MAX,
  CALL_LIMIT_MESSAGE,
  CALL_LIMIT_MIN,
  DISABLE_CALLS_CONFIRM,
  normalizeCallSettings,
  type CallMode,
  type CallSettingsInput,
  type CallSettingsRow,
} from "@/lib/call-view";
import { HttpError } from "@/lib/errors";
import type { OutputRow } from "@/lib/outputs";
import { fromMask, toMask, type PanelOption } from "@/lib/profile-view";

interface Props {
  panels: PanelOption[];
  settings: CallSettingsRow[];
  /** Salidas de la instalación: su alias acompaña a S1–S4. */
  outputs: OutputRow[];
  /** Solo el admin edita; el técnico ve la configuración en solo lectura. */
  canEdit: boolean;
  onSave: (settingsId: string, input: CallSettingsInput) => Promise<ActionResult>;
}

/** Pestaña Llamadas: una tarjeta por panel con el módulo de apertura por llamada. */
export default function CallSettingsManager({ panels, settings, outputs, canEdit, onSave }: Props) {
  return (
    <div className="grid grid-cols-1 gap-8">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">Llamadas</h2>
        <p className="max-w-prose text-sm text-muted">
          Un titular abre llamando desde uno de sus teléfonos. Cada panel decide si atiende llamadas y qué salidas abre.
          {!canEdit && " Solo un administrador puede cambiar esta configuración."}
        </p>
      </div>
      {panels.length === 0 && (
        <p className="text-muted">Esta instalación aún no tiene paneles. Vincula uno en la pestaña Paneles.</p>
      )}
      {panels.map((p) => {
        const fila = settings.find((s) => s.panel_id === p.id);
        return fila ? (
          <CallSettingsCard
            key={fila.id}
            panel={p}
            row={fila}
            outputs={outputs.filter((o) => o.panel_id === p.id)}
            canEdit={canEdit}
            onSave={onSave}
          />
        ) : (
          <section key={p.id} aria-labelledby={`llamadas-${p.id}`} className="grid gap-2">
            <h3 id={`llamadas-${p.id}`} className="font-mono text-base font-semibold">
              {p.panel_code}
            </h3>
            <p className="text-muted">Este panel aún no tiene configuración de llamadas: se crea al vincularlo.</p>
          </section>
        );
      })}
    </div>
  );
}

interface CardProps {
  panel: PanelOption;
  row: CallSettingsRow;
  outputs: OutputRow[];
  canEdit: boolean;
  onSave: Props["onSave"];
}

function CallSettingsCard({ panel, row, outputs, canEdit, onSave }: CardProps) {
  const [enabled, setEnabled] = useState(row.enabled);
  const [mode, setMode] = useState<CallMode>(row.mode);
  const [outputIndex, setOutputIndex] = useState(row.output_index);
  const [menu, setMenu] = useState(() => fromMask(row.menu_mask, OUTPUT_COUNT));
  const [defaultOutput, setDefaultOutput] = useState<number | null>(row.default_output);
  const [limit, setLimit] = useState(String(row.call_limit_per_minute));
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();

  const aliasDe = (i: number) => outputs.find((o) => o.output_index === i)?.alias ?? "";
  const nombre = (i: number) => outputOptionLabel(i, aliasDe(i));

  function alternarMenu(i: number) {
    const siguiente = menu.map((v, j) => (j === i ? !v : v));
    setMenu(siguiente);
    // La predeterminada debe seguir en el menú.
    if (defaultOutput === i && !siguiente[i]) setDefaultOutput(null);
  }

  function guardar() {
    const n = limit.trim() === "" ? Number.NaN : Number(limit);
    let input: CallSettingsInput;
    try {
      if (!Number.isInteger(n)) throw new HttpError(400, CALL_LIMIT_MESSAGE);
      input = normalizeCallSettings({
        enabled,
        mode,
        output_index: outputIndex,
        menu_mask: toMask(menu),
        default_output: defaultOutput,
        call_limit_per_minute: n,
      });
    } catch (err) {
      return setNotice({ kind: "error", text: (err as Error).message });
    }
    if (row.enabled && !input.enabled && !window.confirm(DISABLE_CALLS_CONFIRM)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onSave(row.id, input);
      setNotice(r.ok ? { kind: "ok", text: `Se guardó la configuración de llamadas de ${panel.panel_code}.` } : { kind: "error", text: r.error });
    });
  }

  return (
    <form
      aria-label={`Llamadas de ${panel.panel_code}`}
      noValidate
      className="grid max-w-2xl gap-4 rounded-lg border border-line bg-paper p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canEdit) guardar();
      }}
    >
      <h3 className="font-mono text-base font-semibold">{panel.panel_code}</h3>
      <fieldset disabled={!canEdit || pendiente} className="grid gap-4 border-0 p-0">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Activar módulo
        </label>

        <fieldset className="grid gap-2 border-0 p-0">
          <legend className="text-sm font-medium">Modo</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name={`modo-${panel.id}`} checked={mode === "single"} onChange={() => setMode("single")} />
            <span>
              Una salida
              <span className="block text-muted">No contesta: cuelga y abre la salida elegida.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name={`modo-${panel.id}`} checked={mode === "menu"} onChange={() => setMode("menu")} />
            <span>
              Varias salidas
              <span className="block text-muted">Contesta y espera una tecla de 1 a 4 durante 8 segundos.</span>
            </span>
          </label>
        </fieldset>

        {mode === "single" ? (
          <label className="text-sm font-medium">
            Salida que abre
            <select className="field" value={outputIndex} onChange={(e) => setOutputIndex(Number(e.target.value))}>
              {Array.from({ length: OUTPUT_COUNT }, (_, i) => (
                <option key={i} value={i}>
                  {nombre(i)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <fieldset>
              <legend className="text-sm font-medium">Salidas del menú</legend>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {menu.map((on, i) => (
                  <label key={i} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`${nombre(i)} en el menú`}
                      checked={on}
                      onChange={() => alternarMenu(i)}
                    />
                    {outputLabel(i)}
                    <span className="sr-only">{aliasDe(i)}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">La tecla n abre la salida Sn si está marcada.</p>
            </fieldset>
            <label className="text-sm font-medium">
              Salida predeterminada
              <select
                className="field"
                value={defaultOutput === null ? "" : String(defaultOutput)}
                onChange={(e) => setDefaultOutput(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Ninguna: sin tecla válida no abre</option>
                {menu.map((on, i) =>
                  on ? (
                    <option key={i} value={i}>
                      {nombre(i)}
                    </option>
                  ) : null,
                )}
              </select>
            </label>
          </>
        )}

        <label className="max-w-xs text-sm font-medium">
          Aperturas por minuto por número
          <input
            className="field tabular-nums"
            type="number"
            inputMode="numeric"
            min={CALL_LIMIT_MIN}
            max={CALL_LIMIT_MAX}
            step={1}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
      </fieldset>
      <Notices notice={notice} />
      {canEdit && (
        <div>
          <button type="submit" className="btn" disabled={pendiente}>
            {pendiente ? "Guardando…" : "Guardar"}
          </button>
        </div>
      )}
    </form>
  );
}
