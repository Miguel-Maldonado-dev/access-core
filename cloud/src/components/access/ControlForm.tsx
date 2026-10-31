"use client";

import { useState, type FormEvent } from "react";
import {
  BUTTON_COUNT,
  KEEP_NO_OUTPUT,
  KEEP_NO_OUTPUT_LABEL,
  NO_OUTPUT_LABEL,
  OUTPUT_COUNT,
  outputOptionLabel,
  parseCode,
} from "@/lib/access-view";
import type { ButtonInput, ControlInput, ControlRow } from "@/lib/controls";

/** Panel vinculado de la instalación con el alias de sus 4 salidas (null = sin alias). */
export interface ControlPanel {
  id: string;
  panel_code: string;
  aliases: (string | null)[];
}

interface Props {
  control?: ControlRow;
  holders: { id: string; name: string }[];
  panels: ControlPanel[];
  error?: string;
  pending?: boolean;
  onSubmit: (input: ControlInput) => void;
  onCancel: () => void;
}

/**
 * Una fila del formulario: un botón vivo o un número libre. Las salidas van como texto:
 * "" = Ninguna, `KEEP_NO_OUTPUT` = Sin salida, "0".."3" = S1..S4.
 */
interface Fila {
  key: string;
  id: string | null;
  button: number;
  /** "1", o "1 (2)" para el segundo botón vivo con el mismo número. */
  nombre: string;
  code: string;
  outputs: Record<string, string>;
  /** Paneles donde el botón ya tiene vínculo sin salida: solo ahí se ofrece "Sin salida". */
  sinSalida: Set<string>;
}

const SALIDAS = Array.from({ length: OUTPUT_COUNT }, (_, i) => i);

/**
 * Una fila por botón vivo y una vacía por cada número libre, por número. Con un solo panel,
 * una fila vacía propone que el botón N abra la salida N; con varios, empieza en "Ninguna"
 * para que un botón nuevo no abra en todos los paneles. Un botón vivo muestra lo guardado.
 */
function filasIniciales(control: ControlRow | undefined, panels: ControlPanel[]): Fila[] {
  const vivos = control?.buttons ?? [];
  const filas: Fila[] = [];
  for (let n = 0; n < BUTTON_COUNT; n++) {
    const delNumero = vivos.filter((b) => b.button === n);
    if (delNumero.length === 0) {
      filas.push({
        key: `libre-${n}`,
        id: null,
        button: n,
        nombre: String(n + 1),
        code: "",
        outputs: Object.fromEntries(panels.map((p) => [p.id, panels.length === 1 ? String(n) : ""])),
        sinSalida: new Set(),
      });
    }
    delNumero.forEach((b, k) =>
      filas.push({
        key: b.id,
        id: b.id,
        button: n,
        nombre: k === 0 ? String(n + 1) : `${n + 1} (${k + 1})`,
        code: String(b.rf_code),
        outputs: Object.fromEntries(
          panels.map((p) => {
            const o = b.outputs[p.id];
            return [p.id, o === undefined ? "" : o === null ? KEEP_NO_OUTPUT : String(o)];
          }),
        ),
        sinSalida: new Set(panels.filter((p) => b.outputs[p.id] === null).map((p) => p.id)),
      }),
    );
  }
  return filas;
}

export default function ControlForm({ control, holders, panels, error = "", pending = false, onSubmit, onCancel }: Props) {
  const [holderId, setHolderId] = useState(control?.holder_id ?? "");
  const [description, setDescription] = useState(control?.description ?? "");
  const [filas, setFilas] = useState(() => filasIniciales(control, panels));
  const [localError, setLocalError] = useState("");

  const cambiar = (key: string, cambio: (f: Fila) => Fila) =>
    setFilas((actuales) => actuales.map((f) => (f.key === key ? cambio(f) : f)));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (holderId === "") return setLocalError("Elige un titular.");
    const buttons: ButtonInput[] = [];
    const sinSalida: string[] = [];
    // Sin paneles vinculados no hay salidas que editar: los botones existentes no se tocan.
    for (const f of panels.length === 0 ? [] : filas) {
      if (f.code.trim() === "") {
        if (f.id !== null) buttons.push({ id: f.id, button: f.button, rf_code: null, outputs: {} });
        continue;
      }
      let rf: number;
      try {
        rf = parseCode(f.code);
      } catch (err) {
        return setLocalError(`Botón ${f.nombre}: ${(err as Error).message}`);
      }
      const outputs: ButtonInput["outputs"] = Object.fromEntries(
        panels.map((p) => {
          const v = f.outputs[p.id];
          return [p.id, v === "" ? null : v === KEEP_NO_OUTPUT ? KEEP_NO_OUTPUT : Number(v)];
        }),
      );
      // Sin vínculo en ningún panel vinculado, el botón no hace nada: se borra.
      if (Object.values(outputs).every((o) => o === null)) {
        if (f.id === null) return setLocalError(`Botón ${f.nombre}: elige su salida en al menos un panel.`);
        sinSalida.push(f.nombre);
      }
      buttons.push({ id: f.id, button: f.button, rf_code: rf, outputs });
    }
    for (const nombre of sinSalida) {
      if (!window.confirm(`El botón ${nombre} no tiene salida en ningún panel y se borrará. ¿Continuar?`)) return;
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
      <fieldset className="grid min-w-0 gap-3 sm:col-span-2">
        <legend className="text-sm font-medium">Botones</legend>
        {panels.length === 0 ? (
          <p className="text-sm text-muted">Vincula un panel para asignar salidas a los botones.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Los códigos van en decimal y un botón sin código se ignora. En cada panel elige la salida que abre el
              botón; con {NO_OUTPUT_LABEL} ese panel no lo recibe.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted">
                  <tr>
                    <th scope="col" className="pb-1 pr-3 font-medium">Botón</th>
                    <th scope="col" className="pb-1 pr-3 font-medium">Código RF</th>
                    {panels.map((p) => (
                      <th key={p.id} scope="col" className="pb-1 pr-3 font-mono font-medium whitespace-nowrap">
                        {p.panel_code}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f) => (
                    <tr key={f.key}>
                      <th scope="row" className="pr-3 pb-2 font-medium whitespace-nowrap">
                        Botón {f.nombre}
                      </th>
                      <td className="pr-3 pb-2">
                        <input
                          className="field mt-0 min-w-36 tabular-nums"
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="Decimal"
                          aria-label={`Código del botón ${f.nombre}`}
                          value={f.code}
                          onChange={(e) => {
                            const code = e.target.value;
                            cambiar(f.key, (x) => ({ ...x, code }));
                          }}
                        />
                      </td>
                      {panels.map((p) => (
                        <td key={p.id} className="pr-3 pb-2">
                          <select
                            className="field mt-0 min-w-32"
                            aria-label={`Salida del botón ${f.nombre} en ${p.panel_code}`}
                            value={f.outputs[p.id] ?? ""}
                            onChange={(e) => {
                              const valor = e.target.value;
                              cambiar(f.key, (x) => ({ ...x, outputs: { ...x.outputs, [p.id]: valor } }));
                            }}
                          >
                            <option value="">{NO_OUTPUT_LABEL}</option>
                            {f.sinSalida.has(p.id) && <option value={KEEP_NO_OUTPUT}>{KEEP_NO_OUTPUT_LABEL}</option>}
                            {SALIDAS.map((o) => (
                              <option key={o} value={o}>
                                {outputOptionLabel(o, p.aliases[o])}
                              </option>
                            ))}
                          </select>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
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
