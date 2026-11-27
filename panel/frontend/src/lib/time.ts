export function minutesToHHMM(m: number): string {
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const HHMM = /^(\d{2}):(\d{2})$/;

export function hhmmToMinutes(s: string): number {
  const match = HHMM.exec(s);
  if (match) {
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h <= 23 && m <= 59) return h * 60 + m;
  }
  throw new Error("Horario inválido: usa HH:MM");
}

const MEXICO = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Mexico_City",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function mexicoParts(ms: number): Record<string, string> {
  return Object.fromEntries(MEXICO.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** Hora de México (UTC-6 sin horario de verano) que muestra ese instante, como `AAAA-MM-DDTHH:mm`. */
export function isoToMexicoLocal(iso: string): string {
  const p = mexicoParts(new Date(iso).getTime());
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Interpreta un `datetime-local` como hora de México y lo devuelve en ISO UTC. */
export function mexicoLocalToIso(local: string): string {
  const asUtc = new Date(`${local}:00Z`).getTime();
  if (Number.isNaN(asUtc)) throw new Error("Fecha inválida.");
  // Se corrige con la diferencia que Intl da para ese instante (robusto si cambiara el horario).
  const p = mexicoParts(asUtc);
  const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(asUtc + (asUtc - shown)).toISOString();
}
