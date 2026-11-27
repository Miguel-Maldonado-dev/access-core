import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptPin } from "@/lib/crypto";
import type { Panel } from "@/lib/device/auth";
import type {
  CallSettingsData,
  CardData,
  ContractRow,
  ControlButtonData,
  ControlData,
  HolderData,
  HolderPermissionData,
  OutputData,
  PermissionData,
  PhoneData,
  QrCodeData,
  QrSettingsData,
  TableData,
  TableName,
} from "@/lib/device/contract";

/**
 * Proyección de las tablas de la nube a las tablas locales de UN panel:
 * - holders y cards → igual (el PIN se descifra);
 * - control_buttons → solo los botones vivos con vínculo vivo con ESE panel, con
 *   `output_id` = `output_index` de ese vínculo;
 * - controls → solo los visibles para ESE panel (ver `visibleToPanel`);
 * - access_profiles + la regla viva de ESE panel → permissions (`id` = id del perfil;
 *   sin regla, todas las máscaras en 0);
 * - holder_profiles → holder_permissions (`permission_id` = `local_permission_id`);
 * - outputs de ESE panel → outputs (`output_id` = `output_index`);
 * - phones → igual, solo a un panel v8 con su módulo de llamadas activado (`panelGetsPhones`);
 * - panel_call_settings de ESE panel → call_settings (`output_id` = `output_index`), solo a
 *   un panel v8; `permissions.allow_call` también solo va a un panel v8.
 * - qr_codes → igual (fechas ISO con `.000Z`), solo a un panel v9;
 * - installations (dígito y tope de QR) → qr_settings (`id` = id de la instalación), solo a
 *   un panel v9; `permissions.qr_reader_mask` también solo va a un panel v9.
 * Toda lectura filtra por la instalación del panel (y por el panel en outputs y reglas).
 */

/** Tablas de la nube que alimentan la proyección. */
export type SourceTable =
  | "holders"
  | "cards"
  | "controls"
  | "control_buttons"
  | "control_button_panels"
  | "access_profiles"
  | "profile_panel_rules"
  | "holder_profiles"
  | "outputs"
  | "phones"
  | "panel_call_settings"
  | "qr_codes"
  | "installations";

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
}
export interface ButtonLinkRow {
  id: string;
  button_id: string;
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
  allow_remote: boolean;
  allow_call: boolean;
  qr_reader_mask: number;
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

export interface PhoneRow {
  id: string;
  holder_id: string;
  number: string;
  description: string;
}
export interface QrCodeRow {
  id: string;
  holder_id: string;
  code: number;
  label: string;
  valid_from: string;
  valid_until: string;
  created_at: string;
  max_uses: number;
}
/** Ajustes de QR de la instalación (`id` = id de la instalación). */
export interface InstallationQrRow {
  id: string;
  qr_digit: number;
  qr_max_active: number;
}
export interface CallSettingsRow {
  id: string;
  enabled: boolean;
  mode: CallSettingsData["mode"];
  output_index: number;
  menu_mask: number;
  default_output: number | null;
  call_limit_per_minute: number;
}

/** Columnas que se proyectan de cada tabla de origen (sin `deleted_at` ni `revision`). */
export const SOURCE_COLUMNS: Readonly<Record<SourceTable, string>> = {
  holders: "id, kind, name, department, address, notes, pin_ciphertext",
  cards: "id, card_code, holder_id, description",
  controls: "id, holder_id, description",
  control_buttons: "id, control_id, button, rf_code",
  control_button_panels: "id, button_id, output_index",
  access_profiles: "id, name, local_permission_id",
  profile_panel_rules:
    "id, profile_id, output_mask, card_reader_mask, pin_reader_mask, allow_rf, allow_remote, allow_call, qr_reader_mask, weekday_mask, start_minute, end_minute",
  holder_profiles: "id, holder_id, profile_id",
  outputs: "id, output_index, alias, duration_ms, reader_mask, enabled",
  phones: "id, holder_id, number, description",
  panel_call_settings: "id, enabled, mode, output_index, menu_mask, default_output, call_limit_per_minute",
  qr_codes: "id, holder_id, code, label, valid_from, valid_until, created_at, max_uses",
  // Se lee por `id` (no tiene `installation_id`): ver `fetchQrSettings`.
  installations: "id, qr_digit, qr_max_active",
};

/** Tablas de origen con filas por panel (se filtran también por `panel_id`). */
export const PANEL_SOURCES: ReadonlySet<SourceTable> = new Set([
  "profile_panel_rules",
  "outputs",
  "control_button_panels",
  "panel_call_settings",
]);

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

/** Botón para un panel: `outputIndex` es la salida de su vínculo con ese panel. */
export function projectControlButton(row: ControlButtonRow, outputIndex: number | null): ControlButtonData {
  return {
    control_id: row.control_id,
    button: row.button,
    rf_code: row.rf_code,
    output_id: outputIndex,
  };
}

/**
 * Permiso local de un perfil en un panel: el `name` y el `local_permission_id` del
 * perfil con la regla de ese panel. Sin regla (o con la regla borrada), todas las
 * máscaras en 0 y `allow_rf` y `allow_remote` en false: el perfil no da acceso en ese panel.
 * `allow_remote` se proyecta siempre (entra en la suma de verificación del panel);
 * `allow_call` solo con `withAllowCall` (panel v8): un panel v7 no lo tiene en su suma.
 * `qr_reader_mask` solo con `withQrReaderMask` (panel v9).
 */
export function projectPermission(
  profile: Pick<ProfileRow, "name" | "local_permission_id">,
  ruleForPanel:
    | (Omit<RuleRow, "id" | "profile_id" | "allow_call" | "qr_reader_mask"> & {
        allow_call?: boolean;
        qr_reader_mask?: number;
      })
    | null,
  withAllowCall = true,
  withQrReaderMask = false,
): PermissionData {
  const data: PermissionData = {
    permission_id: profile.local_permission_id,
    name: profile.name,
    output_mask: ruleForPanel?.output_mask ?? 0,
    card_reader_mask: ruleForPanel?.card_reader_mask ?? 0,
    pin_reader_mask: ruleForPanel?.pin_reader_mask ?? 0,
    allow_rf: ruleForPanel?.allow_rf ?? false,
    allow_remote: ruleForPanel?.allow_remote ?? false,
    weekday_mask: ruleForPanel?.weekday_mask ?? 0,
    start_minute: ruleForPanel?.start_minute ?? 0,
    end_minute: ruleForPanel?.end_minute ?? 0,
  };
  if (withAllowCall) data.allow_call = ruleForPanel?.allow_call ?? false;
  if (withQrReaderMask) data.qr_reader_mask = ruleForPanel?.qr_reader_mask ?? 0;
  return data;
}

/** Proyección de un permiso para ESE panel (`allow_call` desde v8, `qr_reader_mask` desde v9). */
export function projectPermissionFor(
  panel: Panel,
  profile: Pick<ProfileRow, "name" | "local_permission_id">,
  ruleForPanel: RuleRow | null,
): PermissionData {
  return projectPermission(profile, ruleForPanel, panel.schema >= 8, panel.schema >= 9);
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

export function projectPhone(row: PhoneRow): PhoneData {
  return { holder_id: row.holder_id, number: row.number, description: row.description };
}

export function projectCallSettings(row: CallSettingsRow): CallSettingsData {
  return {
    enabled: row.enabled,
    mode: row.mode,
    output_id: row.output_index,
    menu_mask: row.menu_mask,
    default_output: row.default_output,
    call_limit_per_minute: row.call_limit_per_minute,
  };
}

/** Fecha de Postgres → ISO-8601 UTC con milisegundos (`...T08:00:00.000Z`), como el panel. */
const isoUtc = (fecha: string) => new Date(fecha).toISOString();

export function projectQrCode(row: QrCodeRow): QrCodeData {
  return {
    holder_id: row.holder_id,
    code: row.code,
    label: row.label,
    valid_from: isoUtc(row.valid_from),
    valid_until: isoUtc(row.valid_until),
    created_at: isoUtc(row.created_at),
    max_uses: row.max_uses,
  };
}

export function projectQrSettings(row: InstallationQrRow): QrSettingsData {
  return { digit: row.qr_digit, max_active: row.qr_max_active };
}

/** El panel recibe teléfonos: es v8 y su módulo de llamadas está activado. */
export function panelGetsPhones(panel: Panel, settings: CallSettingsRow | null): boolean {
  return panel.schema >= 8 && settings?.enabled === true;
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

/**
 * Lo que hace falta para decidir qué controles y botones recibe un panel: los controles y
 * los botones vivos (de la instalación o de un control) y la salida de cada vínculo vivo
 * de esos botones con ESE panel.
 */
export interface ControlContext {
  controls: Map<string, ControlRow>;
  buttons: Map<string, ControlButtonRow>;
  buttonsByControl: Map<string, ControlButtonRow[]>;
  outputByButton: Map<string, number | null>;
}

function buildControlContext(
  controles: ControlRow[],
  botones: ControlButtonRow[],
  vinculos: ButtonLinkRow[],
): ControlContext {
  const buttonsByControl = new Map<string, ControlButtonRow[]>();
  for (const b of botones) {
    const lista = buttonsByControl.get(b.control_id);
    if (lista) lista.push(b);
    else buttonsByControl.set(b.control_id, [b]);
  }
  return {
    controls: new Map(controles.map((c) => [c.id, c])),
    buttons: new Map(botones.map((b) => [b.id, b])),
    buttonsByControl,
    outputByButton: new Map(vinculos.map((v) => [v.button_id, v.output_index])),
  };
}

/** Controles y botones vivos de la instalación, con los vínculos vivos del panel. */
export async function loadControlContext(admin: SupabaseClient, panel: Panel): Promise<ControlContext> {
  const [controles, botones, vinculos] = await Promise.all([
    fetchSourceRows<ControlRow>(admin, panel, "controls"),
    fetchSourceRows<ControlButtonRow>(admin, panel, "control_buttons"),
    fetchSourceRows<ButtonLinkRow>(admin, panel, "control_button_panels"),
  ]);
  return buildControlContext(controles, botones, vinculos);
}

/** El control no tiene botones vivos. */
export function hasNoLiveButtons(ctx: ControlContext, controlId: string): boolean {
  return (ctx.buttonsByControl.get(controlId) ?? []).length === 0;
}

/**
 * El panel recibe el control: está vivo y tiene algún botón vivo vinculado al panel, o no
 * tiene ningún botón vivo (spec §3.2).
 */
export function isControlVisible(ctx: ControlContext, controlId: string): boolean {
  if (!ctx.controls.has(controlId)) return false;
  const botones = ctx.buttonsByControl.get(controlId) ?? [];
  return botones.length === 0 || botones.some((b) => ctx.outputByButton.has(b.id));
}

/**
 * El botón para el panel, o `null` si no lo recibe: debe estar vivo, tener vínculo vivo con
 * el panel y su control vivo (las lecturas del contexto no son atómicas entre tablas: un
 * control borrado entre lecturas no deja al panel con un botón sin padre).
 */
export function buttonForPanel(ctx: ControlContext, buttonId: string): ControlButtonData | null {
  const boton = ctx.buttons.get(buttonId);
  if (!boton || !ctx.outputByButton.has(buttonId) || !ctx.controls.has(boton.control_id)) return null;
  return projectControlButton(boton, ctx.outputByButton.get(buttonId) ?? null);
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

/**
 * El vínculo vivo de un botón con el panel (con su salida), o `null` si el panel no lo
 * recibe.
 */
async function fetchButtonLink(
  admin: SupabaseClient,
  panel: Panel,
  buttonId: string,
): Promise<{ output_index: number | null } | null> {
  const { data, error } = await admin
    .from("control_button_panels")
    .select("output_index")
    .eq("installation_id", panel.installation_id)
    .eq("panel_id", panel.id)
    .eq("button_id", buttonId)
    .is("deleted_at", null)
    .maybeSingle<{ output_index: number | null }>();
  if (error) throw error;
  return data;
}

/**
 * El panel recibe ese control: está vivo y tiene algún botón vivo con vínculo vivo con el
 * panel, o no tiene ningún botón vivo. Misma regla que el snapshot y el feed.
 */
export async function visibleToPanel(admin: SupabaseClient, panel: Panel, controlId: string): Promise<boolean> {
  const control = await fetchSourceRow<ControlRow>(admin, panel, "controls", controlId);
  if (!control) return false;
  const { data: botones, error } = await admin
    .from("control_buttons")
    .select(SOURCE_COLUMNS.control_buttons)
    .eq("installation_id", panel.installation_id)
    .eq("control_id", controlId)
    .is("deleted_at", null)
    .overrideTypes<ControlButtonRow[], { merge: false }>();
  if (error) throw error;
  let vinculos: ButtonLinkRow[] = [];
  if (botones.length > 0) {
    const r = await admin
      .from("control_button_panels")
      .select(SOURCE_COLUMNS.control_button_panels)
      .eq("installation_id", panel.installation_id)
      .eq("panel_id", panel.id)
      .in("button_id", botones.map((b) => b.id))
      .is("deleted_at", null)
      .overrideTypes<ButtonLinkRow[], { merge: false }>();
    if (r.error) throw r.error;
    vinculos = r.data;
  }
  return isControlVisible(buildControlContext([control], botones, vinculos), controlId);
}

/** La configuración de llamadas viva del panel en su instalación, o `null`. */
async function fetchCallSettings(admin: SupabaseClient, panel: Panel): Promise<CallSettingsRow | null> {
  const { data, error } = await admin
    .from("panel_call_settings")
    .select(SOURCE_COLUMNS.panel_call_settings)
    .eq("installation_id", panel.installation_id)
    .eq("panel_id", panel.id)
    .is("deleted_at", null)
    .maybeSingle<CallSettingsRow>();
  if (error) throw error;
  return data;
}

/**
 * La configuración de llamadas viva del panel. Si falta (un panel dado de alta sin
 * `claim_panel` ni importación), la crea con los valores por omisión, como
 * `private.ensure_panel_call_settings`: un panel v8 siempre tiene su fila local y sin la de
 * la nube su suma de `call_settings` nunca coincidiría.
 */
export async function loadCallSettings(admin: SupabaseClient, panel: Panel): Promise<CallSettingsRow | null> {
  const fila = await fetchCallSettings(admin, panel);
  if (fila) return fila;
  const { error } = await admin.from("panel_call_settings").insert({
    installation_id: panel.installation_id,
    panel_id: panel.id,
    updated_at: new Date().toISOString(),
    updated_by: "system:llamadas",
    origin: "cloud",
  });
  // 23505: otra petición la creó mientras tanto.
  if (error && error.code !== "23505") throw error;
  return fetchCallSettings(admin, panel);
}

/** Los ajustes de QR de la instalación del panel. */
export async function fetchQrSettings(admin: SupabaseClient, panel: Panel): Promise<InstallationQrRow> {
  const { data, error } = await admin
    .from("installations")
    .select(SOURCE_COLUMNS.installations)
    .eq("id", panel.installation_id)
    .single<InstallationQrRow>();
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
      return fila && (await visibleToPanel(admin, panel, id)) ? projectControl(fila) : null;
    }
    case "control_buttons": {
      // Sin vínculo vivo con el panel, el botón no existe para él.
      const fila = await fetchSourceRow<ControlButtonRow>(admin, panel, "control_buttons", id);
      if (!fila) return null;
      const vinculo = await fetchButtonLink(admin, panel, id);
      return vinculo && projectControlButton(fila, vinculo.output_index);
    }
    case "permissions": {
      const perfil = await fetchSourceRow<PerfilVivo>(admin, panel, "access_profiles", id);
      return perfil && projectPermissionFor(panel, perfil, await fetchRuleForPanel(admin, panel, id));
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
    case "phones": {
      if (panel.schema < 8 || !panelGetsPhones(panel, await loadCallSettings(admin, panel))) return null;
      const fila = await fetchSourceRow<PhoneRow>(admin, panel, "phones", id);
      return fila && projectPhone(fila);
    }
    case "call_settings": {
      // La fila del panel, sin importar el id (el panel tiene una sola).
      if (panel.schema < 8) return null;
      const fila = await loadCallSettings(admin, panel);
      return fila && projectCallSettings(fila);
    }
    case "qr_codes": {
      if (panel.schema < 9) return null;
      const fila = await fetchSourceRow<QrCodeRow>(admin, panel, "qr_codes", id);
      return fila && projectQrCode(fila);
    }
    case "qr_settings":
      // La fila de la instalación, sin importar el id (el panel tiene una sola).
      return panel.schema < 9 ? null : projectQrSettings(await fetchQrSettings(admin, panel));
  }
}

const porId = (a: ContractRow, b: ContractRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Proyección viva de una tabla local para un panel (snapshot y checksum), ordenada por id.
 * `controls` y `control_buttons`: solo lo que recibe el panel (`isControlVisible` y
 * `buttonForPanel`), con la salida del vínculo de cada botón con el panel.
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
    case "controls": {
      const ctx = await loadControlContext(admin, panel);
      filas = [...ctx.controls.values()]
        .filter((c) => isControlVisible(ctx, c.id))
        .map((c) => ({ id: c.id, data: projectControl(c) }));
      break;
    }
    case "control_buttons": {
      const ctx = await loadControlContext(admin, panel);
      filas = [];
      for (const id of ctx.buttons.keys()) {
        const data = buttonForPanel(ctx, id);
        if (data) filas.push({ id, data });
      }
      break;
    }
    case "permissions": {
      const c = await loadPermissionContext(admin, panel);
      filas = [...c.profiles.values()]
        .filter((p) => p.deleted_at === null)
        .map((p) => ({ id: p.id, data: projectPermissionFor(panel, p, c.rulesByProfile.get(p.id) ?? null) }));
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
    case "phones":
      filas = panel.schema >= 8 && panelGetsPhones(panel, await loadCallSettings(admin, panel))
        ? (await fetchSourceRows<PhoneRow>(admin, panel, "phones")).map((r) => ({ id: r.id, data: projectPhone(r) }))
        : [];
      break;
    case "call_settings": {
      const fila = panel.schema >= 8 ? await loadCallSettings(admin, panel) : null;
      filas = fila ? [{ id: fila.id, data: projectCallSettings(fila) }] : [];
      break;
    }
    case "qr_codes":
      filas = panel.schema >= 9
        ? (await fetchSourceRows<QrCodeRow>(admin, panel, "qr_codes")).map((r) => ({ id: r.id, data: projectQrCode(r) }))
        : [];
      break;
    case "qr_settings": {
      const fila = panel.schema >= 9 ? await fetchQrSettings(admin, panel) : null;
      filas = fila ? [{ id: fila.id, data: projectQrSettings(fila) }] : [];
      break;
    }
  }
  return filas.sort(porId);
}
