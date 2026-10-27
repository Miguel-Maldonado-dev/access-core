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
