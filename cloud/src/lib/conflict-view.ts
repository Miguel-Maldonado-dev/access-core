/** Lo que la interfaz muestra de un conflicto de sincronización (sin `server-only`: lo usan componentes de cliente). */

export type ConflictKind = "lww" | "unique" | "skew";

export interface ConflictRow {
  id: number;
  panel_id: string;
  panel_code: string;
  table_name: string;
  row_id: string;
  kind: ConflictKind;
  resolution: string;
  created_at: string;
  reviewed_at: string | null;
}

export const CONFLICT_KIND_LABEL: Record<ConflictKind, string> = {
  lww: "Versión más reciente",
  unique: "Duplicado",
  skew: "Reloj desfasado",
};
