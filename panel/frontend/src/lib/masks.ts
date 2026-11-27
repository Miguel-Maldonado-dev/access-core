export function toMask(flags: boolean[]): number {
  return flags.reduce((mask, on, i) => (on ? mask | (1 << i) : mask), 0);
}

export function fromMask(mask: number, length: number): boolean[] {
  return Array.from({ length }, (_, i) => (mask & (1 << i)) !== 0);
}

/** Resume los métodos por lector: "L1 T·P·Q, L2 P" (T tarjeta, P PIN, Q QR; solo los habilitados). */
export function readerMethods(cardMask: number, pinMask: number, qrMask: number): string {
  const card = fromMask(cardMask, 4);
  const pin = fromMask(pinMask, 4);
  const qr = fromMask(qrMask, 4);
  return [0, 1, 2, 3]
    .flatMap((i) => {
      const letters = [card[i] ? "T" : "", pin[i] ? "P" : "", qr[i] ? "Q" : ""].filter(Boolean);
      return letters.length > 0 ? [`L${i + 1} ${letters.join("·")}`] : [];
    })
    .join(", ");
}

/** Texto largo para el tooltip: "Reader1 (Tarjeta), Reader2 (PIN, QR)". */
export function readerMethodsTitle(cardMask: number, pinMask: number, qrMask: number): string {
  const masks = [
    ["Tarjeta", fromMask(cardMask, 4)],
    ["PIN", fromMask(pinMask, 4)],
    ["QR", fromMask(qrMask, 4)],
  ] as const;
  return [0, 1, 2, 3]
    .flatMap((i) => {
      const names = masks.filter(([, on]) => on[i]).map(([name]) => name);
      return names.length > 0 ? [`Reader${i + 1} (${names.join(", ")})`] : [];
    })
    .join(", ");
}
