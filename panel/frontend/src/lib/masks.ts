export function toMask(flags: boolean[]): number {
  return flags.reduce((mask, on, i) => (on ? mask | (1 << i) : mask), 0);
}

export function fromMask(mask: number, length: number): boolean[] {
  return Array.from({ length }, (_, i) => (mask & (1 << i)) !== 0);
}
