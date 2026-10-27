import type { Holder } from "./types";

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function deleteHolderMessage(h: Holder): string {
  const parts: string[] = [];
  if (h.card_count > 0) parts.push(count(h.card_count, "tarjeta", "tarjetas"));
  if (h.control_count > 0) parts.push(count(h.control_count, "control", "controles"));
  const base = `¿Borrar "${h.name}"?`;
  return parts.length === 0 ? base : `${base} También se borrarán sus ${parts.join(" y ")}.`;
}
