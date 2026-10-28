import { SOURCE_OPTIONS, sourceLabel, type LogFilters as Filters } from "@/lib/log-view";

interface Props {
  /** Ruta de la pestaña: el formulario es GET, así que los filtros quedan en la URL (compartible). */
  action: string;
  filters: Filters;
  panels: { id: string; panel_code: string }[];
  holders: { id: string; name: string }[];
}

/** Filtros de la pestaña Logs. Al enviar vuelve a la página 1 (no manda `pagina`). */
export default function LogFilters({ action, filters, panels, holders }: Props) {
  const resultado = filters.allowed === undefined ? "" : filters.allowed ? "permitido" : "denegado";
  return (
    <form method="get" action={action} className="panel grid gap-4 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
      <label className="block text-sm font-medium">
        Desde
        <input type="date" name="desde" className="field" defaultValue={filters.from ?? ""} />
      </label>
      <label className="block text-sm font-medium">
        Hasta
        <input type="date" name="hasta" className="field" defaultValue={filters.to ?? ""} />
      </label>
      <label className="block text-sm font-medium">
        Panel
        <select name="panel" className="field" defaultValue={filters.panelId ?? ""}>
          <option value="">Todos</option>
          {panels.map((p) => (
            <option key={p.id} value={p.id}>
              {p.panel_code}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        Titular
        <select name="titular" className="field" defaultValue={filters.holderId ?? ""}>
          <option value="">Todos</option>
          {holders.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        Resultado
        <select name="resultado" className="field" defaultValue={resultado}>
          <option value="">Todos</option>
          <option value="permitido">Permitido</option>
          <option value="denegado">Denegado</option>
        </select>
      </label>
      <label className="block text-sm font-medium">
        Origen
        <select name="origen" className="field" defaultValue={filters.source === undefined ? "" : String(filters.source)}>
          <option value="">Todos</option>
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-3 sm:col-span-2 lg:col-span-6">
        <button type="submit" className="btn">
          Filtrar
        </button>
        <a href={action} className="btn-quiet">
          Limpiar
        </a>
      </div>
    </form>
  );
}
