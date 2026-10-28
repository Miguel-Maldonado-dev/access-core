"use client";

import { useState, useTransition } from "react";
import Notices, { type Notice } from "@/components/Notices";
import { OUTPUT_COUNT, outputLabel } from "@/lib/access-view";
import type { ActionResult } from "@/lib/actions";
import type { OutputRow } from "@/lib/outputs";
import {
  ALL_DAYS,
  DAY_LABELS,
  READER_COUNT,
  fromMask,
  hhmmToMinutes,
  minutesToHHMM,
  readerLabel,
  toMask,
  type PanelOption,
  type PanelRuleInput,
  type RuleRow,
} from "@/lib/profile-view";

interface Props {
  panels: PanelOption[];
  /** Reglas vivas del perfil (a lo más una por panel). */
  rules: RuleRow[];
  /** Salidas de la instalación: su alias es el texto emergente de S1–S4. */
  outputs: OutputRow[];
  onSave: (rules: PanelRuleInput[]) => Promise<ActionResult>;
}

/** Estado editable de una regla; un panel sin regla es `null` ("Sin acceso en este panel"). */
interface RuleState {
  outputs: boolean[];
  cards: boolean[];
  pins: boolean[];
  rf: boolean;
  days: boolean[];
  start: string;
  end: string;
}

const NUEVA: RuleState = {
  outputs: Array(OUTPUT_COUNT).fill(false),
  cards: Array(READER_COUNT).fill(false),
  pins: Array(READER_COUNT).fill(false),
  rf: false,
  days: fromMask(ALL_DAYS, DAY_LABELS.length),
  start: "00:00",
  end: "00:00",
};

const desdeRegla = (r: RuleRow | undefined): RuleState | null =>
  r
    ? {
        outputs: fromMask(r.output_mask, OUTPUT_COUNT),
        cards: fromMask(r.card_reader_mask, READER_COUNT),
        pins: fromMask(r.pin_reader_mask, READER_COUNT),
        rf: r.allow_rf,
        days: fromMask(r.weekday_mask, DAY_LABELS.length),
        start: minutesToHHMM(r.start_minute),
        end: minutesToHHMM(r.end_minute),
      }
    : null;

const alternar = (lista: boolean[], i: number) => lista.map((v, j) => (j === i ? !v : v));

/**
 * Editor de reglas de un perfil: una columna por panel. Cada columna elige salidas (S1–S4,
 * con su alias como texto emergente), lectores de Tarjeta y de PIN, control RF, días y
 * horario, o "Sin acceso en este panel" (se borra la regla al guardar).
 */
export default function ProfileRulesEditor({ panels, rules, outputs, onSave }: Props) {
  const [estado, setEstado] = useState<Record<string, RuleState | null>>(() =>
    Object.fromEntries(panels.map((p) => [p.id, desdeRegla(rules.find((r) => r.panel_id === p.id))])),
  );
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();

  const cambiar = (panelId: string, cambio: Partial<RuleState> | null) =>
    setEstado((cur) => ({ ...cur, [panelId]: cambio === null ? null : { ...(cur[panelId] ?? NUEVA), ...cambio } }));

  function guardar() {
    const payload: PanelRuleInput[] = [];
    for (const p of panels) {
      const s = estado[p.id];
      if (!s) {
        payload.push({ panel_id: p.id, rule: null });
        continue;
      }
      try {
        payload.push({
          panel_id: p.id,
          rule: {
            output_mask: toMask(s.outputs),
            card_reader_mask: toMask(s.cards),
            pin_reader_mask: toMask(s.pins),
            allow_rf: s.rf,
            weekday_mask: toMask(s.days),
            start_minute: hhmmToMinutes(s.start),
            end_minute: hhmmToMinutes(s.end),
          },
        });
      } catch (err) {
        return setNotice({ kind: "error", text: `${p.panel_code}: ${(err as Error).message}` });
      }
    }
    setNotice(null);
    startTransition(async () => {
      const r = await onSave(payload);
      setNotice(r.ok ? { kind: "ok", text: "Se guardaron las reglas." } : { kind: "error", text: r.error });
    });
  }

  if (panels.length === 0) {
    return <p className="text-muted">Esta instalación aún no tiene paneles. Vincula uno en la pestaña Paneles.</p>;
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">
        Lo que el perfil permite se define en cada panel. Un panel sin regla no da acceso a este perfil.
      </p>
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))]">
        {panels.map((p) => {
          const s = estado[p.id];
          const alias = (i: number) => outputs.find((o) => o.panel_id === p.id && o.output_index === i)?.alias ?? "";
          return (
            <section key={p.id} aria-label={`Regla en ${p.panel_code}`} className="grid gap-4 rounded-lg border border-line bg-paper p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-mono text-sm font-semibold">{p.panel_code}</h4>
                {s ? (
                  <button type="button" className="link-danger text-sm" onClick={() => cambiar(p.id, null)}>
                    Sin acceso en este panel
                  </button>
                ) : (
                  <button type="button" className="link-action text-sm" onClick={() => cambiar(p.id, {})}>
                    Dar acceso en este panel
                  </button>
                )}
              </div>
              {!s ? (
                <p className="text-sm text-muted">Sin acceso en este panel.</p>
              ) : (
                <>
                  <fieldset>
                    <legend className="text-sm font-medium">Salidas</legend>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                      {s.outputs.map((on, i) => (
                        <label key={i} className="flex items-center gap-2 text-sm" title={alias(i) || undefined}>
                          <input
                            type="checkbox"
                            aria-label={`${outputLabel(i)}${alias(i) ? ` (${alias(i)})` : ""} en ${p.panel_code}`}
                            checked={on}
                            onChange={() => cambiar(p.id, { outputs: alternar(s.outputs, i) })}
                          />
                          {outputLabel(i)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="text-sm font-medium">Lectores</legend>
                    <table className="mt-2 text-sm">
                      <thead>
                        <tr>
                          <th scope="col" className="pr-5 text-left font-medium">
                            <span className="sr-only">Lector</span>
                          </th>
                          <th scope="col" className="px-3 text-center font-medium">Tarjeta</th>
                          <th scope="col" className="px-3 text-center font-medium">PIN</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.cards.map((_, i) => (
                          <tr key={i}>
                            <th scope="row" className="pr-5 text-left font-normal">{readerLabel(i)}</th>
                            <td className="px-3 text-center">
                              <input
                                type="checkbox"
                                aria-label={`Tarjeta ${readerLabel(i)} en ${p.panel_code}`}
                                checked={s.cards[i]}
                                onChange={() => cambiar(p.id, { cards: alternar(s.cards, i) })}
                              />
                            </td>
                            <td className="px-3 text-center">
                              <input
                                type="checkbox"
                                aria-label={`PIN ${readerLabel(i)} en ${p.panel_code}`}
                                checked={s.pins[i]}
                                onChange={() => cambiar(p.id, { pins: alternar(s.pins, i) })}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </fieldset>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      aria-label={`Permitir control RF en ${p.panel_code}`}
                      checked={s.rf}
                      onChange={(e) => cambiar(p.id, { rf: e.target.checked })}
                    />
                    Permitir control RF
                  </label>
                  <fieldset>
                    <legend className="text-sm font-medium">Días</legend>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                      {DAY_LABELS.map((dia, i) => (
                        <label key={dia} className="flex items-center gap-1.5 text-sm">
                          <input
                            type="checkbox"
                            aria-label={`${dia} en ${p.panel_code}`}
                            checked={s.days[i]}
                            onChange={() => cambiar(p.id, { days: alternar(s.days, i) })}
                          />
                          {dia}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-sm font-medium">
                      Desde
                      <input
                        className="field tabular-nums"
                        type="time"
                        aria-label={`Desde en ${p.panel_code}`}
                        value={s.start}
                        onChange={(e) => cambiar(p.id, { start: e.target.value })}
                      />
                    </label>
                    <label className="text-sm font-medium">
                      Hasta
                      <input
                        className="field tabular-nums"
                        type="time"
                        aria-label={`Hasta en ${p.panel_code}`}
                        value={s.end}
                        onChange={(e) => cambiar(p.id, { end: e.target.value })}
                      />
                    </label>
                  </div>
                  <p className="text-xs text-muted">
                    Si Desde y Hasta son iguales, vale todo el día. Si Desde es mayor que Hasta, el horario cruza la
                    medianoche.
                  </p>
                </>
              )}
            </section>
          );
        })}
      </div>
      <Notices notice={notice} />
      <div>
        <button type="button" className="btn" disabled={pendiente} onClick={guardar}>
          {pendiente ? "Guardando…" : "Guardar reglas"}
        </button>
      </div>
    </div>
  );
}
