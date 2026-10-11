import type { LogFilterState } from "@/lib/logQuery";
import type { Holder } from "@/lib/types";

interface Props {
  value: LogFilterState;
  holders: Holder[];
  onChange: (next: LogFilterState) => void;
}

export default function LogFilters({ value, holders, onChange }: Props) {
  const toNumber = (v: string) => (v === "" ? undefined : Number(v));
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <label className="block text-sm font-medium">
        Desde
        <input
          type="date"
          className="field"
          value={value.dateFrom ?? ""}
          onChange={(e) => onChange({ ...value, dateFrom: e.target.value || undefined })}
        />
      </label>
      <label className="block text-sm font-medium">
        Hasta
        <input
          type="date"
          className="field"
          value={value.dateTo ?? ""}
          onChange={(e) => onChange({ ...value, dateTo: e.target.value || undefined })}
        />
      </label>
      <label className="block text-sm font-medium">
        Titular
        <select
          className="field"
          value={value.holderId === undefined ? "" : String(value.holderId)}
          onChange={(e) => onChange({ ...value, holderId: toNumber(e.target.value) })}
        >
          <option value="">Todos</option>
          {holders.map((h) => (
            <option key={h.holder_id} value={h.holder_id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        Resultado
        <select
          className="field"
          value={value.allowed === undefined ? "" : String(value.allowed)}
          onChange={(e) => onChange({ ...value, allowed: e.target.value === "" ? undefined : e.target.value === "true" })}
        >
          <option value="">Todos</option>
          <option value="true">Permitido</option>
          <option value="false">Denegado</option>
        </select>
      </label>
      <label className="block text-sm font-medium">
        Origen
        <select
          className="field"
          value={value.source === undefined ? "" : String(value.source)}
          onChange={(e) => onChange({ ...value, source: toNumber(e.target.value) })}
        >
          <option value="">Todos</option>
          <option value="0">Tarjeta</option>
          <option value="1">Control RF</option>
          <option value="2">Botón de salida</option>
        </select>
      </label>
    </div>
  );
}
