"use client";

import { useState, type FormEvent } from "react";
import { fromMask, toMask } from "@/lib/masks";
import { hhmmToMinutes, minutesToHHMM } from "@/lib/time";
import type { Permission } from "@/lib/types";

export type PermissionPayload = Permission;

const OUTPUTS = ["Relay1", "Relay2", "Relay3", "Relay4"];
const READERS = ["Reader1", "Reader2", "Reader3", "Reader4"];
const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

interface Props {
  permission?: Permission;
  onSubmit: (payload: PermissionPayload) => void | Promise<void>;
  onCancel?: () => void;
}

function Checks({ legend, labels, value, onChange }: {
  legend: string;
  labels: string[];
  value: boolean[];
  onChange: (next: boolean[]) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
        {labels.map((label, i) => (
          <label key={label} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value[i]}
              onChange={() => onChange(value.map((v, j) => (j === i ? !v : v)))}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function PermissionForm({ permission, onSubmit, onCancel }: Props) {
  const [id, setId] = useState(String(permission?.permission_id ?? 0));
  const [name, setName] = useState(permission?.name ?? "");
  const [outputs, setOutputs] = useState(fromMask(permission?.output_mask ?? 0, 4));
  const [cardReaders, setCardReaders] = useState(fromMask(permission?.card_reader_mask ?? 0, 4));
  const [pinReaders, setPinReaders] = useState(fromMask(permission?.pin_reader_mask ?? 0, 4));
  const [days, setDays] = useState(fromMask(permission?.weekday_mask ?? 0, 7));
  const [start, setStart] = useState(minutesToHHMM(permission?.start_minute ?? 0));
  const [end, setEnd] = useState(minutesToHHMM(permission?.end_minute ?? 0));
  const [allowRf, setAllowRf] = useState(permission?.allow_rf ?? false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const permissionId = Number(id);
    if (id.trim() === "" || !Number.isInteger(permissionId) || permissionId < 0 || permissionId > 31) {
      setError("El número de permiso debe estar entre 0 y 31.");
      return;
    }
    if (name.trim() === "") {
      setError("El nombre es obligatorio.");
      return;
    }
    let startMinute: number;
    let endMinute: number;
    try {
      startMinute = hhmmToMinutes(start);
      endMinute = hhmmToMinutes(end);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Horario inválido: usa HH:MM");
      return;
    }
    setError("");
    await onSubmit({
      permission_id: permissionId,
      name: name.trim(),
      output_mask: toMask(outputs),
      card_reader_mask: toMask(cardReaders),
      pin_reader_mask: toMask(pinReaders),
      weekday_mask: toMask(days),
      start_minute: startMinute,
      end_minute: endMinute,
      allow_rf: allowRf,
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      {error !== "" && (
        <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">
          {error}
        </p>
      )}
      <label className="text-sm font-medium">
        Número
        <input
          className="field"
          type="number"
          min={0}
          max={31}
          value={id}
          disabled={permission !== undefined}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <label className="text-sm font-medium">
        Nombre
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <Checks legend="Salidas" labels={OUTPUTS} value={outputs} onChange={setOutputs} />
      <fieldset>
        <legend className="text-sm font-medium">Lectores</legend>
        <table className="mt-2 text-sm">
          <thead>
            <tr>
              <th scope="col" className="pr-6 text-left font-medium">
                <span className="sr-only">Lector</span>
              </th>
              <th scope="col" className="px-3 text-center font-medium">Tarjeta</th>
              <th scope="col" className="px-3 text-center font-medium">PIN</th>
            </tr>
          </thead>
          <tbody>
            {READERS.map((reader, i) => (
              <tr key={reader}>
                <th scope="row" className="pr-6 text-left font-normal">{reader}</th>
                <td className="px-3 text-center">
                  <input
                    type="checkbox"
                    aria-label={`Tarjeta ${reader}`}
                    checked={cardReaders[i]}
                    onChange={() => setCardReaders(cardReaders.map((v, j) => (j === i ? !v : v)))}
                  />
                </td>
                <td className="px-3 text-center">
                  <input
                    type="checkbox"
                    aria-label={`PIN ${reader}`}
                    checked={pinReaders[i]}
                    onChange={() => setPinReaders(pinReaders.map((v, j) => (j === i ? !v : v)))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>
      <div className="sm:col-span-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={allowRf} onChange={(e) => setAllowRf(e.target.checked)} />
          Permitir control RF
        </label>
        <p className="mt-1 text-sm text-muted">
          El control RF no depende del lector: usa las salidas, días y horario de este permiso.
        </p>
      </div>
      <div className="sm:col-span-2">
        <Checks legend="Días" labels={DAYS} value={days} onChange={setDays} />
      </div>
      <label className="text-sm font-medium">
        Desde
        <input className="field" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="text-sm font-medium">
        Hasta
        <input className="field" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <p className="text-sm text-muted sm:col-span-2">
        Si Desde y Hasta son iguales, el permiso vale todo el día. Si Desde es mayor que Hasta, el horario cruza la
        medianoche.
      </p>
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
