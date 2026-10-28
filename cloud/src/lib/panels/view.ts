/**
 * Lo que la interfaz muestra de un panel (sin `server-only`: lo usan componentes de cliente).
 * `PanelRow` son las columnas no secretas que `authenticated` puede leer.
 */

export type PanelStatus = "pending" | "claimed" | "staging" | "awaiting_review" | "active" | "revoked";

export interface PanelRow {
  id: string;
  panel_code: string;
  status: PanelStatus;
  online: boolean;
  last_sync_at: string | null;
  synced_revision: number;
  software_version: string | null;
  sync_blocked: { table: string; would_delete: number; total: number } | null;
}

export const PANEL_STATUS_LABEL: Record<PanelStatus, string> = {
  pending: "Pendiente",
  claimed: "Reclamado",
  staging: "Preparando",
  awaiting_review: "En revisión",
  active: "Activo",
  revoked: "Revocado",
};

/** El panel va atrás de la instalación: aún no aplica todos sus cambios. */
export function isBehind(panel: Pick<PanelRow, "synced_revision">, installationRevision: number): boolean {
  return panel.synced_revision < installationRevision;
}

/** Fecha local legible, o "Nunca" si el panel no ha sincronizado. */
export function formatSync(iso: string | null): string {
  if (!iso) return "Nunca";
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "Nunca";
  return fecha.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

/** Nombre en la interfaz de cada tabla replicada (para el aviso de borrados bloqueados). */
export const TABLE_LABEL: Record<string, string> = {
  holders: "titulares",
  cards: "tarjetas",
  controls: "controles",
  control_buttons: "botones",
  permissions: "perfiles",
  holder_permissions: "asignaciones de perfil",
  outputs: "salidas",
};
