const MAX_CODE = 4294967295;
const DIGITS = /^\d+$/;

export function parseCode(text: string): number {
  const t = text.trim();
  const n = DIGITS.test(t) ? Number(t) : NaN;
  if (!Number.isSafeInteger(n) || n > MAX_CODE) {
    throw new Error("Usa solo números (0 a 4294967295).");
  }
  return n;
}
