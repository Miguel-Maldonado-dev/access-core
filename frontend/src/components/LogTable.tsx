import { formatDateTime, holderKindLabel, mediumLabel, outputLabel, reasonLabel } from "@/lib/format";
import type { LogItem } from "@/lib/types";

const HEADERS = ["Fecha", "Resultado", "Titular", "Medio de acceso", "Código", "Salida", "Motivo"];

export default function LogTable({ items }: { items: LogItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-paper text-muted">
          <tr>
            {HEADERS.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((log) => (
            <tr key={log.log_id} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatDateTime(log.timestamp)}</td>
              <td className={`px-4 py-2 font-semibold ${log.allowed ? "text-signal" : "text-danger"}`}>
                {log.allowed ? "PERMITIDO" : "DENEGADO"}
              </td>
              <td className="px-4 py-2">
                {log.holder_name === null
                  ? "-"
                  : `${log.holder_name}${log.holder_kind ? ` · ${holderKindLabel(log.holder_kind)}` : ""}`}
              </td>
              <td className="px-4 py-2">{mediumLabel(log)}</td>
              <td className="px-4 py-2 tabular-nums">{log.code === null ? "-" : log.code}</td>
              <td className="px-4 py-2">{outputLabel(log.output_id)}</td>
              <td className="px-4 py-2">{reasonLabel(log.reason)}</td>
            </tr>
          ))}
          {items.length === 0 && (
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
