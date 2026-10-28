import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  esUuid,
  fetchAll,
  holderNames,
  isMissingParent,
  isUniqueViolation,
  HOLDER_GONE,
  requireInstallationAccess,
} from "@/lib/access-data";
import { HttpError } from "@/lib/errors";
import {
  MAX_PROFILES,
  MAX_PROFILES_MESSAGE,
  NAME_MAX,
  type PanelRuleInput,
  type RuleInput,
  type RuleRow,
} from "@/lib/profile-view";

/**
 * Perfiles de acceso de una instalación como el usuario de la sesión (RLS; admin y técnico).
 * El perfil se define y se asigna a titulares a nivel instalación; lo que permite se guarda
 * en una regla por panel (`profile_panel_rules`). `local_permission_id` (0..31) es el
 * `permission_id` que recibe cada panel: el menor libre entre los perfiles vivos. Un vínculo
 * no se edita: cambiarlo es borrado lógico + alta. La revisión y la cascada del borrado de un
 * perfil (asignaciones y reglas) las hacen los triggers de la base.
 */

export interface ProfileRow {
  id: string;
  name: string;
  local_permission_id: number;
  /** Titulares vivos que tienen el perfil. */
  holder_ids: string[];
  /** Reglas vivas, a lo más una por panel. */
  rules: RuleRow[];
}

const REGLA_COLUMNAS =
  "id, profile_id, panel_id, output_mask, card_reader_mask, pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute";
const CAMPOS_REGLA = [
  "output_mask",
  "card_reader_mask",
  "pin_reader_mask",
  "allow_rf",
  "weekday_mask",
  "start_minute",
  "end_minute",
] as const;

const NO_EXISTE = "El perfil no existe.";
const CHOQUE = "Otro usuario modificó esto al mismo tiempo. Recarga la página e inténtalo de nuevo.";
const REGLA_INVALIDA = "La regla no es válida.";
const PANEL_INVALIDO = "El panel no existe o ya no está vinculado.";

const entero = (min: number, max: number) => z.int().min(min).max(max);
const reglaEsquema = z.strictObject({
  output_mask: entero(0, 15),
  card_reader_mask: entero(0, 15),
  pin_reader_mask: entero(0, 15),
  allow_rf: z.boolean(),
  weekday_mask: entero(0, 127),
  start_minute: entero(0, 1439),
  end_minute: entero(0, 1439),
});

/** Nombre del perfil: obligatorio, hasta 60 caracteres y sin NUL (Postgres lo rechaza). */
function parseName(nombre: unknown): string {
  const limpio = typeof nombre === "string" ? nombre.trim() : "";
  if (limpio === "") throw new HttpError(400, "Escribe el nombre del perfil.");
  if (limpio.length > NAME_MAX) throw new HttpError(400, `El nombre admite hasta ${NAME_MAX} caracteres.`);
  if (limpio.includes("\u0000")) throw new HttpError(400, "El nombre contiene caracteres no válidos.");
  return limpio;
}

function trozos<T>(lista: T[], tamano: number): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < lista.length; i += tamano) r.push(lista.slice(i, i + tamano));
  return r;
}

const ahora = () => new Date().toISOString();

/** Perfiles vivos con sus titulares y reglas, por número de permiso (cualquier miembro). */
export async function listProfilesAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
): Promise<ProfileRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const [perfiles, reglas, asignaciones] = await Promise.all([
    fetchAll<{ id: string; name: string; local_permission_id: number }>((desde, hasta) =>
      cliente
        .from("access_profiles")
        .select("id, name, local_permission_id")
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("local_permission_id")
        .order("id")
        .range(desde, hasta),
    ),
    fetchAll<RuleRow>((desde, hasta) =>
      cliente
        .from("profile_panel_rules")
        .select(REGLA_COLUMNAS)
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("id")
        .range(desde, hasta),
    ),
    fetchAll<{ profile_id: string; holder_id: string }>((desde, hasta) =>
      cliente
        .from("holder_profiles")
        .select("profile_id, holder_id")
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("id")
        .range(desde, hasta),
    ),
  ]);

  const reglasDe = new Map<string, RuleRow[]>();
  for (const r of reglas) reglasDe.set(r.profile_id, [...(reglasDe.get(r.profile_id) ?? []), r]);
  const titularesDe = new Map<string, string[]>();
  for (const a of asignaciones) titularesDe.set(a.profile_id, [...(titularesDe.get(a.profile_id) ?? []), a.holder_id]);
  return perfiles.map((p) => ({ ...p, holder_ids: titularesDe.get(p.id) ?? [], rules: reglasDe.get(p.id) ?? [] }));
}

/** Titulares vivos (id y nombre, por nombre) para elegir a quién se asigna un perfil. */
export async function listHolderOptionsAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
): Promise<{ id: string; name: string }[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const nombres = await holderNames(cliente, installationId);
  return [...nombres]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id));
}

/** 404 si el perfil no existe (vivo) en la instalación. */
async function requireProfile(cliente: SupabaseClient, installationId: string, profileId: unknown) {
  if (!esUuid(profileId)) throw new HttpError(404, NO_EXISTE);
  const { data, error } = await cliente
    .from("access_profiles")
    .select("id, name")
    .eq("id", profileId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle<{ id: string; name: string }>();
  if (error) throw error;
  if (!data) throw new HttpError(404, NO_EXISTE);
  return data;
}

/**
 * Crea un perfil con el menor `local_permission_id` libre. Con 32 vivos, 409. Si otra alta
 * se queda con el mismo número, el índice único la rechaza: se recalcula y se reintenta.
 */
export async function createProfileAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  nombre: unknown,
): Promise<{ id: string; local_permission_id: number }> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const name = parseName(nombre);

  for (let intento = 0; intento < 3; intento++) {
    const { data: vivos, error } = await cliente
      .from("access_profiles")
      .select("local_permission_id")
      .eq("installation_id", installationId)
      .is("deleted_at", null);
    if (error) throw error;
    const usados = new Set((vivos as { local_permission_id: number }[]).map((v) => v.local_permission_id));
    let libre = 0;
    while (usados.has(libre)) libre++;
    if (libre >= MAX_PROFILES) throw new HttpError(409, MAX_PROFILES_MESSAGE);

    const { data, error: errorAlta } = await cliente
      .from("access_profiles")
      .insert({ installation_id: installationId, name, local_permission_id: libre })
      .select("id, local_permission_id")
      .single<{ id: string; local_permission_id: number }>();
    if (!errorAlta) return data;
    if (!isUniqueViolation(errorAlta, "access_profiles_local_permission_id_live_key")) throw errorAlta;
  }
  throw new HttpError(409, "Otro usuario creó un perfil al mismo tiempo. Inténtalo de nuevo.");
}

/** Cambia el nombre (el número de permiso no cambia). */
export async function renameProfileAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  profileId: string,
  nombre: unknown,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const name = parseName(nombre);
  const perfil = await requireProfile(cliente, installationId, profileId);
  if (perfil.name === name) return;
  const { data, error } = await cliente
    .from("access_profiles")
    .update({ name })
    .eq("id", perfil.id)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new HttpError(404, NO_EXISTE);
}

/** Borrado lógico del perfil; el trigger lo extiende a sus asignaciones y reglas y libera el número. */
export async function deleteProfileAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  profileId: string,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  if (!esUuid(profileId)) throw new HttpError(404, NO_EXISTE);
  const { data, error } = await cliente
    .from("access_profiles")
    .update({ deleted_at: ahora() })
    .eq("id", profileId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new HttpError(404, NO_EXISTE);
}

function traducirRegla(error: { code?: string; message?: string }): never {
  if (isUniqueViolation(error, "profile_panel_rules_profile_panel_live_key")) throw new HttpError(409, CHOQUE);
  if (isMissingParent(error)) throw new HttpError(409, "El perfil o el panel ya no existe.");
  throw error;
}

/**
 * Guarda las reglas del perfil por panel: `rule` null = sin acceso en ese panel (borrado
 * lógico de la regla viva); con regla, se inserta o se actualiza solo si cambió (cada
 * escritura sube la revisión y avisa a los paneles). Los paneles que no vienen no se tocan.
 * Se valida todo antes de escribir; PostgREST no ofrece transacciones, así que un fallo a
 * mitad deja aplicados los paneles anteriores.
 */
export async function saveProfileRulesAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  profileId: string,
  entrada: PanelRuleInput[],
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const perfil = await requireProfile(cliente, installationId, profileId);

  if (!Array.isArray(entrada)) throw new HttpError(400, REGLA_INVALIDA);
  const pedidos = new Map<string, RuleInput | null>();
  for (const e of entrada) {
    if (!e || !esUuid(e.panel_id) || pedidos.has(e.panel_id)) throw new HttpError(400, PANEL_INVALIDO);
    if (e.rule === null) {
      pedidos.set(e.panel_id, null);
      continue;
    }
    const r = reglaEsquema.safeParse(e.rule);
    if (!r.success) throw new HttpError(400, REGLA_INVALIDA);
    pedidos.set(e.panel_id, r.data);
  }
  if (pedidos.size === 0) return;

  const { data: paneles, error: errorPaneles } = await cliente
    .from("panels")
    .select("id")
    .eq("installation_id", installationId)
    .neq("status", "revoked")
    .in("id", [...pedidos.keys()]);
  if (errorPaneles) throw errorPaneles;
  if ((paneles as { id: string }[]).length !== pedidos.size) throw new HttpError(400, PANEL_INVALIDO);

  const { data: vigentes, error: errorVigentes } = await cliente
    .from("profile_panel_rules")
    .select(REGLA_COLUMNAS)
    .eq("profile_id", perfil.id)
    .is("deleted_at", null);
  if (errorVigentes) throw errorVigentes;
  const porPanel = new Map((vigentes as RuleRow[]).map((r) => [r.panel_id, r]));

  for (const [panelId, regla] of pedidos) {
    const actual = porPanel.get(panelId);
    if (regla === null) {
      if (!actual) continue;
      const { error } = await cliente
        .from("profile_panel_rules")
        .update({ deleted_at: ahora() })
        .eq("id", actual.id)
        .is("deleted_at", null);
      if (error) traducirRegla(error);
    } else if (!actual) {
      const { error } = await cliente
        .from("profile_panel_rules")
        .insert({ installation_id: installationId, profile_id: perfil.id, panel_id: panelId, ...regla });
      if (error) traducirRegla(error);
    } else if (CAMPOS_REGLA.some((c) => actual[c] !== regla[c])) {
      const { error } = await cliente.from("profile_panel_rules").update(regla).eq("id", actual.id).is("deleted_at", null);
      if (error) traducirRegla(error);
    }
  }
}

/**
 * Deja asignado el perfil exactamente a esos titulares: da de baja (borrado lógico) a los
 * que ya no están y da de alta a los nuevos; los que siguen no se tocan.
 */
export async function setProfileHoldersAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  profileId: string,
  holderIds: unknown,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const perfil = await requireProfile(cliente, installationId, profileId);
  if (!Array.isArray(holderIds) || !holderIds.every(esUuid)) throw new HttpError(400, "Datos inválidos.");
  const deseados = new Set<string>(holderIds);

  const vivos = await holderNames(cliente, installationId);
  if ([...deseados].some((id) => !vivos.has(id))) throw new HttpError(409, HOLDER_GONE);

  const actuales = await fetchAll<{ id: string; holder_id: string }>((desde, hasta) =>
    cliente
      .from("holder_profiles")
      .select("id, holder_id")
      .eq("profile_id", perfil.id)
      .is("deleted_at", null)
      .order("id")
      .range(desde, hasta),
  );
  const tienen = new Set(actuales.map((a) => a.holder_id));
  const bajas = actuales.filter((a) => !deseados.has(a.holder_id)).map((a) => a.id);
  const altas = [...deseados].filter((id) => !tienen.has(id));

  for (const grupo of trozos(bajas, 100)) {
    const { error } = await cliente.from("holder_profiles").update({ deleted_at: ahora() }).in("id", grupo);
    if (error) throw error;
  }
  for (const grupo of trozos(altas, 500)) {
    const { error } = await cliente
      .from("holder_profiles")
      .insert(grupo.map((holder_id) => ({ installation_id: installationId, holder_id, profile_id: perfil.id })));
    if (error) {
      if (isUniqueViolation(error, "holder_profiles_holder_profile_live_key")) throw new HttpError(409, CHOQUE);
      if (isMissingParent(error)) throw new HttpError(409, "El perfil o un titular ya no existe.");
      throw error;
    }
  }
}
