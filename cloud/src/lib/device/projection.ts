import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptPin } from "@/lib/crypto";
import type { Panel } from "@/lib/device/auth";
import type {
  CardData,
  ContractRow,
  ControlButtonData,
  ControlData,
  HolderData,
  HolderPermissionData,
  OutputData,
  PermissionData,
  TableData,
  TableName,
} from "@/lib/device/contract";

/**
 * Proyección de las tablas de la nube a las tablas locales de UN panel:
 * - holders, cards, controls → igual (el PIN se descifra);
 * - control_buttons → `output_id` = `output_index`;
 * - access_profiles + la regla viva de ESE panel → permissions (`id` = id del perfil;
 *   sin regla, todas las máscaras en 0);
 * - holder_profiles → holder_permissions (`permission_id` = `local_permission_id`);
 * - outputs de ESE panel → outputs (`output_id` = `output_index`).
 * Toda lectura filtra por la instalación del panel (y por el panel en outputs y reglas).
 */

/** Tablas de la nube que alimentan la proyección. */
export type SourceTable =
  | "holders"
  | "cards"
  | "controls"
  | "control_buttons"
  | "access_profiles"
  | "profile_panel_rules"
  | "holder_profiles"
  | "outputs";

// Filas de la nube: solo las columnas que se proyectan (nunca pin_lookup).
export interface HolderRow {
  id: string;
  kind: HolderData["kind"];
  name: string;
  department: string;
  address: string;
  notes: string;
  pin_ciphertext: string | null;
}
export interface CardRow {
  id: string;
  card_code: number;
  holder_id: string;
  description: string;
}
export interface ControlRow {
  id: string;
  holder_id: string;
  description: string;
}
export interface ControlButtonRow {
  id: string;
  control_id: string;
  button: number;
  rf_code: number;
  output_index: number | null;
}
export interface ProfileRow {
  id: string;
  name: string;
  local_permission_id: number;
  deleted_at: string | null;
}
export interface RuleRow {
  id: string;
  profile_id: string;
  output_mask: number;
  card_reader_mask: number;
  pin_reader_mask: number;
  allow_rf: boolean;
  weekday_mask: number;
  start_minute: number;
  end_minute: number;
}
export interface HolderProfileRow {
  id: string;
  holder_id: string;
  profile_id: string;
}
export interface OutputRow {
  id: string;
  output_index: number;
  alias: string;
  duration_ms: number;
  reader_mask: number;
  enabled: boolean;
}

/** Columnas que se proyectan de cada tabla de origen (sin `deleted_at` ni `revision`). */
export const SOURCE_COLUMNS: Readonly<Record<SourceTable, string>> = {
  holders: "id, kind, name, department, address, notes, pin_ciphertext",
  cards: "id, card_code, holder_id, description",
  controls: "id, holder_id, description",
  control_buttons: "id, control_id, button, rf_code, output_index",
  access_profiles: "id, name, local_permission_id",
  profile_panel_rules:
    "id, profile_id, output_mask, card_reader_mask, pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute",
  holder_profiles: "id, holder_id, profile_id",
  outputs: "id, output_index, alias, duration_ms, reader_mask, enabled",
};

/** Tablas de origen con filas por panel (se filtran también por `panel_id`). */
export const PANEL_SOURCES: ReadonlySet<SourceTable> = new Set(["profile_panel_rules", "outputs"]);

// ---------------------------------------------------------------------------
// Proyección de una fila (funciones puras)
// ---------------------------------------------------------------------------

export function projectHolder(row: HolderRow): HolderData {
  return {
    kind: row.kind,
    name: row.name,
    department: row.department,
    address: row.address,
    notes: row.notes,
    pin: row.pin_ciphertext === null ? null : decryptPin(row.pin_ciphertext),
  };
}

export function projectCard(row: CardRow): CardData {
  return { card_code: row.card_code, holder_id: row.holder_id, description: row.description };
}

export function projectControl(row: ControlRow): ControlData {
  return { holder_id: row.holder_id, description: row.description };
}

export function projectControlButton(row: ControlButtonRow): ControlButtonData {
  return {
    control_id: row.control_id,
    button: row.button,
    rf_code: row.rf_code,
    output_id: row.output_index,
  };
}

/**
 * Permiso local de un perfil en un panel: el `name` y el `local_permission_id` del
 * perfil con la regla de ese panel. Sin regla (o con la regla borrada), todas las
 * máscaras en 0 y `allow_rf=false`: el perfil no da acceso en ese panel.
 */
export function projectPermission(
  profile: Pick<ProfileRow, "name" | "local_permission_id">,
  ruleForPanel: Omit<RuleRow, "id" | "profile_id"> | null,
): PermissionData {
  return {
    permission_id: profile.local_permission_id,
    name: profile.name,
    output_mask: ruleForPanel?.output_mask ?? 0,
    card_reader_mask: ruleForPanel?.card_reader_mask ?? 0,
    pin_reader_mask: ruleForPanel?.pin_reader_mask ?? 0,
    allow_rf: ruleForPanel?.allow_rf ?? false,
    weekday_mask: ruleForPanel?.weekday_mask ?? 0,
    start_minute: ruleForPanel?.start_minute ?? 0,
    end_minute: ruleForPanel?.end_minute ?? 0,
  };
}

export function projectHolderPermission(row: HolderProfileRow, localPermissionId: number): HolderPermissionData {
  return { holder_id: row.holder_id, permission_id: localPermissionId };
}

export function projectOutput(row: OutputRow): OutputData {
  return {
    output_id: row.output_index,
    alias: row.alias,
    duration_ms: row.duration_ms,
    reader_mask: row.reader_mask,
    enabled: row.enabled,
  };
}

// ---------------------------------------------------------------------------
// Lectura de la nube
// ---------------------------------------------------------------------------

/** Filas por consulta al leer tablas completas (no rebasa `max_rows` de PostgREST). */
const PAGINA_LECTURA = 1000;

/**
 * Lee todas las filas de una tabla de origen del panel (de su instalación y, en outputs y
 * reglas, de ese panel), por páginas con llave `id`. Termina con una página vacía y no
 * con una incompleta: si PostgREST recorta las páginas (`max_rows` menor), no se pierde
 * nada en silencio. Con `includeDeleted` trae también las borradas, con `deleted_at`.
 */
export async function fetchSourceRows<T extends { id: string }>(
  admin: SupabaseClient,
  panel: Panel,
  table: SourceTable,
  { includeDeleted = false }: { includeDeleted?: boolean } = {},
): Promise<T[]> {
  const filas: T[] = [];
  let ultimoId: string | null = null;
  for (;;) {
    let consulta = admin
      .from(table)
      .select(includeDeleted ? `${SOURCE_COLUMNS[table]}, deleted_at` : SOURCE_COLUMNS[table])
      .eq("installation_id", panel.installation_id);
    if (PANEL_SOURCES.has(table)) consulta = consulta.eq("panel_id", panel.id);
    if (!includeDeleted) consulta = consulta.is("deleted_at", null);
    if (ultimoId !== null) consulta = consulta.gt("id", ultimoId);
    const { data, error } = await consulta
      .order("id")
      .limit(PAGINA_LECTURA)
      .overrideTypes<T[], { merge: false }>();
    if (error) throw error;
    if (data.length === 0) return filas;
    filas.push(...data);
    ultimoId = data[data.length - 1].id;
  }
}

/**
 * Lo que hace falta para proyectar permissions y holder_permissions en un panel:
 * todos los perfiles de la instalación (también los borrados, para saber si un cambio
 * es un borrado y su `local_permission_id`) y las reglas vivas de ese panel por perfil.
 */
export interface PermissionContext {
  profiles: Map<string, ProfileRow>;
  rulesByProfile: Map<string, RuleRow>;
}

/** Todos los perfiles de la instalación del panel (también los borrados), por id. */
export async function loadProfiles(admin: SupabaseClient, panel: Panel): Promise<Map<string, ProfileRow>> {
  const perfiles = await fetchSourceRows<ProfileRow>(admin, panel, "access_profiles", { includeDeleted: true });
  return new Map(perfiles.map((p) => [p.id, p]));
}

export async function loadPermissionContext(admin: SupabaseClient, panel: Panel): Promise<PermissionContext> {
  const [profiles, reglas] = await Promise.all([
    loadProfiles(admin, panel),
    fetchSourceRows<RuleRow>(admin, panel, "profile_panel_rules"),
  ]);
  return { profiles, rulesByProfile: new Map(reglas.map((r) => [r.profile_id, r])) };
}

/** Perfil de la instalación; si no está, la proyección no puede seguir (dato incoherente). */
export function profileFrom(profiles: Map<string, ProfileRow>, profileId: string): ProfileRow {
  const perfil = profiles.get(profileId);
  if (!perfil) throw new Error(`Perfil ${profileId} no encontrado en la instalación del panel.`);
  return perfil;
}

/**
 * Una fila viva de una tabla de origen del panel por `id` (de su instalación y, en
 * outputs y reglas, de ese panel), o `null` si no existe, está borrada o es de otro alcance.
 */
async function fetchSourceRow<T>(
  admin: SupabaseClient,
  panel: Panel,
  table: SourceTable,
  id: string,
): Promise<T | null> {
  let consulta = admin
    .from(table)
    .select(SOURCE_COLUMNS[table])
    .eq("installation_id", panel.installation_id)
    .eq("id", id)
    .is("deleted_at", null);
  if (PANEL_SOURCES.has(table)) consulta = consulta.eq("panel_id", panel.id);
  const { data, error } = await consulta.maybeSingle<T>();
  if (error) throw error;
  return data;
}

/** Perfil leído con `SOURCE_COLUMNS` (sin `deleted_at`). */
type PerfilVivo = Omit<ProfileRow, "deleted_at">;

/** La regla viva de un perfil en el panel, o `null`. */
async function fetchRuleForPanel(admin: SupabaseClient, panel: Panel, profileId: string): Promise<RuleRow | null> {
  const { data, error } = await admin
    .from("profile_panel_rules")
    .select(SOURCE_COLUMNS.profile_panel_rules)
    .eq("installation_id", panel.installation_id)
    .eq("panel_id", panel.id)
    .eq("profile_id", profileId)
    .is("deleted_at", null)
    .maybeSingle<RuleRow>();
  if (error) throw error;
  return data;
}

/**
 * Proyección viva de UN registro de una tabla local para un panel (el `current` de
 * `POST /changes`), o `null` si para ese panel el registro no existe.
 */
export async function liveRow(
  admin: SupabaseClient,
  panel: Panel,
  table: TableName,
  id: string,
): Promise<TableData[TableName] | null> {
  switch (table) {
    case "holders": {
      const fila = await fetchSourceRow<HolderRow>(admin, panel, "holders", id);
      return fila && projectHolder(fila);
    }
    case "cards": {
      const fila = await fetchSourceRow<CardRow>(admin, panel, "cards", id);
      return fila && projectCard(fila);
    }
    case "controls": {
      const fila = await fetchSourceRow<ControlRow>(admin, panel, "controls", id);
      return fila && projectControl(fila);
    }
    case "control_buttons": {
      const fila = await fetchSourceRow<ControlButtonRow>(admin, panel, "control_buttons", id);
      return fila && projectControlButton(fila);
    }
    case "permissions": {
      const perfil = await fetchSourceRow<PerfilVivo>(admin, panel, "access_profiles", id);
      return perfil && projectPermission(perfil, await fetchRuleForPanel(admin, panel, id));
    }
    case "holder_permissions": {
      const asignacion = await fetchSourceRow<HolderProfileRow>(admin, panel, "holder_profiles", id);
      if (!asignacion) return null;
      // Una asignación viva apunta a un perfil vivo (trigger y cascada de N3).
      const perfil = await fetchSourceRow<PerfilVivo>(admin, panel, "access_profiles", asignacion.profile_id);
      if (!perfil) throw new Error(`Perfil ${asignacion.profile_id} no encontrado en la instalación del panel.`);
      return projectHolderPermission(asignacion, perfil.local_permission_id);
    }
    case "outputs": {
      const fila = await fetchSourceRow<OutputRow>(admin, panel, "outputs", id);
      return fila && projectOutput(fila);
    }
  }
}

const porId = (a: ContractRow, b: ContractRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Proyección viva de una tabla local para un panel (snapshot y checksum), ordenada por id.
 * `permissions`: una fila por perfil vivo, con la regla viva de ese panel o máscaras en 0.
 * `holder_permissions`: los holder_profiles vivos.
 */
export async function liveRows(admin: SupabaseClient, panel: Panel, table: TableName): Promise<ContractRow[]> {
  let filas: ContractRow[];
  switch (table) {
    case "holders":
      filas = (await fetchSourceRows<HolderRow>(admin, panel, "holders")).map((r) => ({
        id: r.id,
        data: projectHolder(r),
      }));
      break;
    case "cards":
      filas = (await fetchSourceRows<CardRow>(admin, panel, "cards")).map((r) => ({
        id: r.id,
        data: projectCard(r),
      }));
      break;
    case "controls":
      filas = (await fetchSourceRows<ControlRow>(admin, panel, "controls")).map((r) => ({
        id: r.id,
        data: projectControl(r),
      }));
      break;
    case "control_buttons":
      filas = (await fetchSourceRows<ControlButtonRow>(admin, panel, "control_buttons")).map((r) => ({
        id: r.id,
        data: projectControlButton(r),
      }));
      break;
    case "permissions": {
      const c = await loadPermissionContext(admin, panel);
      filas = [...c.profiles.values()]
        .filter((p) => p.deleted_at === null)
        .map((p) => ({ id: p.id, data: projectPermission(p, c.rulesByProfile.get(p.id) ?? null) }));
      break;
    }
    case "holder_permissions": {
      // Primero las asignaciones y después los perfiles: todo perfil al que apunta una
      // asignación leída ya existe cuando se leen los perfiles (FK).
      const asignaciones = await fetchSourceRows<HolderProfileRow>(admin, panel, "holder_profiles");
      const perfiles = await loadProfiles(admin, panel);
      filas = asignaciones.map((r) => ({
        id: r.id,
        data: projectHolderPermission(r, profileFrom(perfiles, r.profile_id).local_permission_id),
      }));
      break;
    }
    case "outputs":
      filas = (await fetchSourceRows<OutputRow>(admin, panel, "outputs")).map((r) => ({
        id: r.id,
        data: projectOutput(r),
      }));
      break;
  }
  return filas.sort(porId);
}
