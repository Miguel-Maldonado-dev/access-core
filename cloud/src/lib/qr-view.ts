import { localDayStartUtc } from "@/lib/log-view";

/** Piezas de los códigos QR compartidas por servidor y navegador. */

export const QR_MAX_USES = 100;
export const QR_USES_MESSAGE = `Los usos deben ser de 1 a ${QR_MAX_USES}.`;
export const QR_DATES_MESSAGE = "Escribe cuándo empieza y cuándo termina la vigencia.";
export const QR_RANGE_MESSAGE = "La vigencia debe terminar después de empezar.";
export const QR_DIGIT_MESSAGE = "El dígito de QR debe ser de 1 a 9.";
export const QR_MAX_ACTIVE = 100_000;
export const QR_MAX_ACTIVE_MESSAGE = `El máximo de QR vigentes debe ser de 1 a ${QR_MAX_ACTIVE}.`;

export const QR_STATUS_LABELS = { pending: "Pendiente", active: "Vigente", expired: "Vencido" } as const;

const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/** Fecha y hora capturadas (`AAAA-MM-DDTHH:MM`, hora de México) → instante UTC en ISO; `null` si no son válidas. */
export function mexicoLocalToIso(valor: string): string | null {
  const m = LOCAL.exec(valor);
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) return null;
  const inicio = Date.parse(localDayStartUtc(m[1]));
  if (Number.isNaN(inicio)) return null;
  return new Date(inicio + (Number(m[2]) * 60 + Number(m[3])) * 60_000).toISOString();
}

const entrada = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Mexico_City",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Valor para un `datetime-local` (hora de México) a `horas` horas de ahora. */
export function mexicoInputIn(horas: number, ahora: Date = new Date()): string {
  return entrada.format(new Date(ahora.getTime() + horas * 3_600_000)).replace(" ", "T");
}
