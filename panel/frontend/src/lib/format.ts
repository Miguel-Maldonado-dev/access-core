import type { HolderKind, LogItem } from "./types";

const REASONS: Record<number, string> = {
  0: "Permitido",
  1: "Tarjeta desconocida",
  2: "Sin salida",
  3: "Sin permiso",
  4: "Error UART",
  5: "Control desconocido",
  6: "Botón sin salida",
  7: "Botón de salida",
  8: "PIN desconocido",
  9: "PIN no permitido",
  10: "PIN bloqueado",
};

const SOURCES: Record<number, string> = {
  0: "Tarjeta",
  1: "Control RF",
  2: "Botón de salida",
  3: "PIN",
  5: "Prueba",
};

export function reasonLabel(reason: number): string {
  return REASONS[reason] ?? `Motivo ${reason}`;
}

export function sourceLabel(source: number): string {
  return SOURCES[source] ?? `Origen ${source}`;
}

export function outputLabel(id: number | null): string {
  return id === null ? "-" : `Relay${id + 1}`;
}

export function holderKindLabel(kind: HolderKind): string {
  return kind === "persona" ? "Persona" : "Domicilio";
}

export function mediumLabel(log: LogItem): string {
  const device = log.device_id;
  if (log.source === 0) {
    const reader = device === null ? "" : ` · Reader${device + 1}`;
    return `${log.credential_label ?? "Tarjeta"}${reader}`;
  }
  if (log.source === 1) {
    if (log.reason === 5) return "Control no registrado";
    const name = log.credential_label ?? (log.control_id !== null ? `Control ${log.control_id}` : "Control borrado");
    return device === null ? name : `${name} · Botón ${device + 1}`;
  }
  if (log.source === 3) {
    return device === null ? "PIN" : `PIN · Reader${device + 1}`;
  }
  if (log.source === 5) return log.credential_label ?? "Prueba";
  return device === null ? "Botón de salida" : `Botón de salida ${device + 1}`;
}

const dateTime = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}
