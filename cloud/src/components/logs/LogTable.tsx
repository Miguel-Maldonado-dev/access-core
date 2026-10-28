import { formatDateTime, holderKindLabel, mediumLabel, outputLabel, reasonLabel, type LogRow } from "@/lib/log-view";

const HEADERS = ["Fecha", "Panel", "Resultado", "Titular", "Medio", "Código", "Salida", "Motivo"];

/** Tabla de logs. El código va en decimal y un log de PIN nunca lo muestra. */
export default function LogTable({ rows }: { rows: LogRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-paper text-muted">
          <tr>
            {HEADERS.map((h) => (
              <th key={h} scope="col" className="whitespace-nowrap px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((log) => (
            <tr key={log.id} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDateTime(log.ts)}</td>
              <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{log.panel_code}</td>
              <td className={`px-4 py-2 font-semibold ${log.allowed ? "text-signal" : "text-danger"}`}>
                {log.allowed ? "Permitido" : "Denegado"}
              </td>
              <td className="px-4 py-2 [overflow-wrap:anywhere]">
                {log.holder_name === null
                  ? "-"
                  : `${log.holder_name}${log.holder_kind ? ` · ${holderKindLabel(log.holder_kind)}` : ""}`}
              </td>
              <td className="px-4 py-2">{mediumLabel(log)}</td>
              <td className="px-4 py-2 tabular-nums">{log.source === 3 || log.code === null ? "-" : log.code}</td>
              <td className="px-4 py-2">{outputLabel(log.output_index, log.output_alias)}</td>
              <td className="px-4 py-2">{reasonLabel(log.reason)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={HEADERS.length} className="px-4 py-6 text-center text-muted">
                No hay registros con estos filtros.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
