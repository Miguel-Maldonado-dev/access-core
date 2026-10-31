import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Panel } from "@/lib/device/auth";
import { tableChecksum } from "@/lib/device/checksum";
import {
  TABLES,
  type ChangeItem,
  type ChecksumsResponse,
  type PullResponse,
  type SnapshotResponse,
  type TableName,
} from "@/lib/device/contract";
import {
  PANEL_SOURCES,
  SOURCE_COLUMNS,
  buttonForPanel,
  hasNoLiveButtons,
  isControlVisible,
  liveRows,
  loadControlContext,
  loadPermissionContext,
  profileFrom,
  projectCard,
  projectControl,
  projectHolder,
  projectHolderPermission,
  projectOutput,
  projectPermission,
  type ButtonLinkRow,
  type CardRow,
  type ControlButtonRow,
  type ControlContext,
  type HolderProfileRow,
  type HolderRow,
  type OutputRow,
  type PermissionContext,
  type RuleRow,
  type SourceTable,
} from "@/lib/device/projection";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Bajada de datos de la nube a un panel: `GET /changes`, `/checksums` y `/snapshot`.
 *
 * Consistencia: primero se lee R = installations.revision. Las revisiones son únicas por
 * instalación y se confirman en orden (bump_revision bloquea la instalación hasta el fin
 * de la transacción), así que toda fila con revision ≤ R ya está confirmada. El pull trae
 * solo filas con since < revision ≤ R; lo que cambie después tendrá revision > R y llega
 * en el siguiente pull.
 */

/** Tablas de origen que consulta el pull, en el orden en que se leen. */
const ORIGENES_PULL: readonly SourceTable[] = [
  "holders",
  "cards",
  "controls",
  "control_buttons",
  "control_button_panels",
  "access_profiles",
  "profile_panel_rules",
  "holder_profiles",
  "outputs",
];

/** Orígenes que se proyectan a `permissions` (por perfil) o necesitan los perfiles. */
const ORIGENES_DE_PERFILES: ReadonlySet<SourceTable> = new Set([
  "access_profiles",
  "profile_panel_rules",
  "holder_profiles",
]);

/** Orígenes que se proyectan con lo que recibe el panel de controles y botones. */
const ORIGENES_DE_CONTROLES: ReadonlySet<SourceTable> = new Set([
  "controls",
  "control_buttons",
  "control_button_panels",
]);

/**
 * Columnas extra del feed por origen. Un vínculo trae el control de su botón (aunque el
 * botón esté borrado): sin él no se sabe qué control revisar tras el `delete` del botón.
 */
const COLUMNAS_EXTRA: Partial<Record<SourceTable, string>> = {
  control_button_panels: ", boton:control_buttons(control_id)",
};

/** Un cambio de vínculo leído del feed, con el control de su botón. */
type VinculoCrudo = ButtonLinkRow & { boton: { control_id: string } };

interface Marcas {
  id: string;
  revision: number;
  deleted_at: string | null;
}

interface FilaCruda {
  origen: SourceTable;
  fila: Marcas & Record<string, unknown>;
}

/** Tabla local que recibe un origen que no es de permisos. */
const TABLA_LOCAL: Partial<Record<SourceTable, TableName>> = {
  holders: "holders",
  cards: "cards",
  controls: "controls",
  control_buttons: "control_buttons",
  holder_profiles: "holder_permissions",
  outputs: "outputs",
};

function isConfirmDeletionsActive(until: string | null, now = Date.now()): boolean {
  return until !== null && Date.parse(until) > now;
}

/** `installations.revision`: la última revisión asignada en la instalación. */
export async function readInstallationRevision(admin: SupabaseClient, installationId: string): Promise<number> {
  const { data, error } = await admin
    .from("installations")
    .select("revision")
    .eq("id", installationId)
    .single<{ revision: number }>();
  if (error) throw error;
  return data.revision;
}

async function leerConfirmarBorrados(admin: SupabaseClient, panelId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("panels")
    .select("confirm_deletions_until")
    .eq("id", panelId)
    .single<{ confirm_deletions_until: string | null }>();
  if (error) throw error;
  return isConfirmDeletionsActive(data.confirm_deletions_until);
}

/** Guarda `synced_revision = since` y `last_sync_at`; devuelve `confirm_deletions`. */
async function registrarPull(admin: SupabaseClient, panelId: string, since: number): Promise<boolean> {
  const { data, error } = await admin
    .from("panels")
    .update({ synced_revision: since, last_sync_at: new Date().toISOString() })
    .eq("id", panelId)
    .select("confirm_deletions_until")
    .single<{ confirm_deletions_until: string | null }>();
  if (error) throw error;
  return isConfirmDeletionsActive(data.confirm_deletions_until);
}

/** Hasta `cuantas` filas de un origen con since < revision ≤ R, por revisión. */
async function leerCambiosDeOrigen(
  admin: SupabaseClient,
  panel: Panel,
  origen: SourceTable,
  since: number,
  R: number,
  cuantas: number,
): Promise<FilaCruda[]> {
  let consulta = admin
    .from(origen)
    .select(`${SOURCE_COLUMNS[origen]}, deleted_at, revision${COLUMNAS_EXTRA[origen] ?? ""}`)
    .eq("installation_id", panel.installation_id)
    .gt("revision", since)
    .lte("revision", R);
  if (PANEL_SOURCES.has(origen)) consulta = consulta.eq("panel_id", panel.id);
  const { data, error } = await consulta
    .order("revision")
    .limit(cuantas)
    .overrideTypes<FilaCruda["fila"][], { merge: false }>();
  if (error) throw error;
  return data.map((fila) => ({ origen, fila }));
}

/** Proyección de un cambio que no es de permisos (`id` y `revision` de la fila). */
function proyectarCambio(
  { origen, fila }: FilaCruda,
  ctx: PermissionContext | null,
): ChangeItem {
  const table = TABLA_LOCAL[origen];
  if (!table) throw new Error(`El origen ${origen} se proyecta a permissions.`);
  const { id, revision } = fila;
  if (fila.deleted_at !== null) return { table, op: "delete", id, revision };
  switch (origen) {
    case "holders":
      return { table: "holders", op: "upsert", id, revision, data: projectHolder(fila as unknown as HolderRow) };
    case "cards":
      return { table: "cards", op: "upsert", id, revision, data: projectCard(fila as unknown as CardRow) };
    case "holder_profiles": {
      const asignacion = fila as unknown as HolderProfileRow;
      const perfil = profileFrom(ctx!.profiles, asignacion.profile_id);
      return {
        table: "holder_permissions",
        op: "upsert",
        id,
        revision,
        data: projectHolderPermission(asignacion, perfil.local_permission_id),
      };
    }
    case "outputs":
      return { table: "outputs", op: "upsert", id, revision, data: projectOutput(fila as unknown as OutputRow) };
    default:
      throw new Error(`Origen sin proyección: ${origen}.`);
  }
}

/**
 * Proyección para el panel de un cambio de `controls`, `control_buttons` o
 * `control_button_panels` (de ESTE panel), con el estado vigente de `ctx`. Agrega a
 * `cambios`, con la revisión del cambio de origen:
 * - controls: `upsert` si el panel recibe el control; si no, `delete`;
 * - botón B (cambio del botón o de su vínculo): si el panel recibe B, `upsert` de B,
 *   precedido del `upsert` de su control si aún no salió en la página (`controlesEnviados`);
 *   si no, `delete` de B seguido del `delete` de su control si el panel dejó de recibirlo,
 *   o del `upsert` si ahora lo recibe porque se quedó sin botones.
 * Una misma (tabla, id) puede repetirse en la página: el panel aplica en orden y es
 * idempotente.
 */
function proyectarDeControles(
  { origen, fila }: FilaCruda,
  ctx: ControlContext,
  controlesEnviados: Set<string>,
  cambios: ChangeItem[],
): void {
  const { revision } = fila;
  const enviarControl = (controlId: string) => {
    const control = ctx.controls.get(controlId);
    if (control && isControlVisible(ctx, controlId)) {
      cambios.push({ table: "controls", op: "upsert", id: controlId, revision, data: projectControl(control) });
      controlesEnviados.add(controlId);
    } else {
      cambios.push({ table: "controls", op: "delete", id: controlId, revision });
    }
  };

  if (origen === "controls") {
    enviarControl(fila.id);
    return;
  }
  const [botonId, controlId] =
    origen === "control_buttons"
      ? [fila.id, (fila as unknown as ControlButtonRow).control_id]
      : [(fila as unknown as VinculoCrudo).button_id, (fila as unknown as VinculoCrudo).boton.control_id];
  const boton = buttonForPanel(ctx, botonId);
  if (boton) {
    if (!controlesEnviados.has(boton.control_id)) enviarControl(boton.control_id);
    cambios.push({ table: "control_buttons", op: "upsert", id: botonId, revision, data: boton });
    return;
  }
  cambios.push({ table: "control_buttons", op: "delete", id: botonId, revision });
  // El control vigente del botón (si sigue vivo) o el que tenía al borrarse.
  const suControl = ctx.buttons.get(botonId)?.control_id ?? controlId;
  if (!isControlVisible(ctx, suControl) || hasNoLiveButtons(ctx, suControl)) enviarControl(suControl);
}

/**
 * Cambios de la instalación para un panel desde `since`, en páginas de `limit` cambios
 * de origen ordenados por revisión.
 * - Si `since >= R` responde `changes: []` sin consultar las tablas replicadas.
 * - Los cambios de controles, botones y vínculos de ESTE panel se proyectan con lo que el
 *   panel recibe hoy (ver `proyectarDeControles`).
 * - Un cambio de un perfil o de su regla para ESTE panel emite `permissions` con la
 *   proyección vigente (una regla borrada da máscaras en 0); solo el borrado del perfil
 *   emite `delete`. Si un perfil aparece varias veces en la página, sale una sola entrada
 *   con la revisión más alta.
 * - `revision` = R si no hay más; si `has_more`, la revisión del último cambio devuelto.
 * - Guarda `panels.synced_revision = since` y `last_sync_at`.
 */
export async function listChanges(panel: Panel, since: number, limit: number): Promise<PullResponse> {
  const admin = createAdminSupabase();
  const [confirmDeletions, R] = await Promise.all([
    registrarPull(admin, panel.id, since),
    readInstallationRevision(admin, panel.installation_id),
  ]);
  if (since >= R) return { revision: R, has_more: false, confirm_deletions: confirmDeletions, changes: [] };

  // Con limit + 1 filas por origen basta: las primeras limit + 1 de la mezcla están ahí.
  const porOrigen = await Promise.all(
    ORIGENES_PULL.map((origen) => leerCambiosDeOrigen(admin, panel, origen, since, R, limit + 1)),
  );
  const crudas = porOrigen.flat().sort((a, b) => a.fila.revision - b.fila.revision);
  const hasMore = crudas.length > limit;
  const pagina = crudas.slice(0, limit);

  // Los perfiles y las reglas se leen después de la página: todo perfil al que apunta
  // una fila de la página ya existe (FK) y la proyección usa su versión vigente.
  // Igual con los controles, los botones y los vínculos del panel (estado vigente).
  const [ctx, ctxControles] = await Promise.all([
    pagina.some((c) => ORIGENES_DE_PERFILES.has(c.origen)) ? loadPermissionContext(admin, panel) : null,
    pagina.some((c) => ORIGENES_DE_CONTROLES.has(c.origen)) ? loadControlContext(admin, panel) : null,
  ]);

  const cambios: ChangeItem[] = [];
  const revisionPorPerfil = new Map<string, number>();
  const controlesEnviados = new Set<string>();
  for (const cruda of pagina) {
    if (ORIGENES_DE_CONTROLES.has(cruda.origen)) {
      proyectarDeControles(cruda, ctxControles!, controlesEnviados, cambios);
    } else if (cruda.origen === "access_profiles" || cruda.origen === "profile_panel_rules") {
      const perfilId =
        cruda.origen === "access_profiles" ? cruda.fila.id : (cruda.fila as unknown as RuleRow).profile_id;
      // La página va en orden de revisión: la última vista es la más alta.
      revisionPorPerfil.set(perfilId, cruda.fila.revision);
    } else {
      cambios.push(proyectarCambio(cruda, ctx));
    }
  }
  for (const [perfilId, revision] of revisionPorPerfil) {
    const perfil = profileFrom(ctx!.profiles, perfilId);
    cambios.push(
      perfil.deleted_at !== null
        ? { table: "permissions", op: "delete", id: perfilId, revision }
        : {
            table: "permissions",
            op: "upsert",
            id: perfilId,
            revision,
            data: projectPermission(perfil, ctx!.rulesByProfile.get(perfilId) ?? null),
          },
    );
  }
  // `sort` es estable: el control que precede a su botón (misma revisión) sigue antes.
  cambios.sort((a, b) => a.revision - b.revision);

  return {
    revision: hasMore ? pagina[pagina.length - 1].fila.revision : R,
    has_more: hasMore,
    confirm_deletions: confirmDeletions,
    changes: cambios,
  };
}

/** `GET /snapshot?table=T`: la proyección viva de una tabla para el panel, con R. */
export async function panelSnapshot(panel: Panel, table: TableName): Promise<SnapshotResponse> {
  const admin = createAdminSupabase();
  const revision = await readInstallationRevision(admin, panel.installation_id);
  return { revision, rows: await liveRows(admin, panel, table) };
}

/** `GET /checksums`: el checksum de la proyección viva de cada tabla, con R. */
export async function panelChecksums(panel: Panel): Promise<ChecksumsResponse> {
  const admin = createAdminSupabase();
  const [revision, confirmDeletions] = await Promise.all([
    readInstallationRevision(admin, panel.installation_id),
    leerConfirmarBorrados(admin, panel.id),
  ]);
  const sumas = await Promise.all(
    TABLES.map(async (tabla) => [tabla, tableChecksum(await liveRows(admin, panel, tabla))] as const),
  );
  return {
    revision,
    confirm_deletions: confirmDeletions,
    tables: Object.fromEntries(sumas) as Record<TableName, string>,
  };
}
