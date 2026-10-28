import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  esUuid,
  fetchAll,
  holderNames,
  isMissingParent,
  isUniqueViolation,
  HOLDER_GONE,
  requireHolder,
  requireInstallationAccess,
} from "@/lib/access-data";
import { BUTTON_COUNT, CODE_MESSAGE, MAX_CODE, OUTPUT_COUNT, rfTakenMessage } from "@/lib/access-view";
import { HttpError } from "@/lib/errors";

/**
 * Controles RF de una instalación como el usuario de la sesión (RLS). Cada control tiene
 * hasta 4 botones (`button` 0..3) con su código RF decimal y su salida (`output_index` 0..3 o null).
 * PostgREST no ofrece transacciones: antes de escribir se valida todo (incluida la unicidad
 * del RF) y las escrituras van de modo que un choque inesperado no deje botones sueltos.
 */

export interface ButtonInput {
  rf_code: number | null;
  output_index: number | null;
}

export interface ControlInput {
  holder_id: string;
  description: string;
  /** Exactamente 4 posiciones, una por botón; `rf_code: null` = botón sin usar. */
  buttons: ButtonInput[];
}

export interface ButtonRow {
  button: number;
  rf_code: number;
  output_index: number | null;
}

export interface ControlRow {
  id: string;
  holder_id: string;
  holder_name: string;
  description: string;
  buttons: ButtonRow[];
}

interface Boton {
  id: string;
  control_id: string;
  button: number;
  rf_code: number;
  output_index: number | null;
}

const BOTON_COLUMNAS = "id, control_id, button, rf_code, output_index";

/** Valida los botones y devuelve solo los usados, con su posición. */
function parseButtons(botones: unknown): Array<{ button: number; rf_code: number; output_index: number | null }> {
  if (!Array.isArray(botones) || botones.length !== BUTTON_COUNT) {
    throw new HttpError(400, `El control debe tener exactamente ${BUTTON_COUNT} botones.`);
  }
  const usados: Array<{ button: number; rf_code: number; output_index: number | null }> = [];
  botones.forEach((b: ButtonInput | null, button) => {
    const rf = b?.rf_code ?? null;
    if (rf === null) return;
    if (!Number.isSafeInteger(rf) || rf < 0 || rf > MAX_CODE) throw new HttpError(400, CODE_MESSAGE);
    usados.push({ button, rf_code: rf, output_index: b?.output_index ?? null });
  });
  if (new Set(usados.map((u) => u.rf_code)).size !== usados.length) {
    throw new HttpError(400, "Cada botón del control debe tener un código distinto.");
  }
  for (const u of usados) {
    const o = u.output_index;
    if (o !== null && (!Number.isInteger(o) || o < 0 || o >= OUTPUT_COUNT)) {
      throw new HttpError(400, `La salida debe estar entre 0 y ${OUTPUT_COUNT - 1}.`);
    }
  }
  return usados;
}

const descripcionDe = (d: unknown) => (typeof d === "string" ? d.trim() : "");

/** 409 si alguno de los códigos ya es de un botón vivo de OTRO control. */
async function checkRfFree(
  cliente: SupabaseClient,
  installationId: string,
  codigos: number[],
  controlId: string | null,
): Promise<void> {
  if (codigos.length === 0) return;
  const { data: ocupados, error } = await cliente
    .from("control_buttons")
    .select("rf_code, control_id")
    .eq("installation_id", installationId)
    .in("rf_code", codigos)
    .is("deleted_at", null);
  if (error) throw error;
  const ajenos = (ocupados as { rf_code: number; control_id: string }[]).filter((o) => o.control_id !== controlId);
  if (ajenos.length === 0) return;
  const primero = ajenos.sort((a, b) => codigos.indexOf(a.rf_code) - codigos.indexOf(b.rf_code))[0];
  const { data: control, error: errorControl } = await cliente
    .from("controls")
    .select("holder_id")
    .eq("id", primero.control_id)
    .maybeSingle<{ holder_id: string }>();
  if (errorControl) throw errorControl;
  const nombre = control
    ? ((await holderNames(cliente, installationId, [control.holder_id])).get(control.holder_id) ?? "otro titular")
    : "otro titular";
  throw new HttpError(409, rfTakenMessage(primero.rf_code, nombre));
}

function traducir(error: { code?: string; message?: string }): never {
  if (isUniqueViolation(error, "control_buttons_rf_code_live_key")) {
    throw new HttpError(409, "Uno de los códigos ya está registrado en otro control.");
  }
  if (isMissingParent(error)) throw new HttpError(409, HOLDER_GONE);
  throw error;
}

/** Controles vivos con titular y botones usados, por titular y descripción (cualquier miembro). */
export async function listControlsAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
): Promise<ControlRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const [controles, botones, nombres] = await Promise.all([
    fetchAll<{ id: string; holder_id: string; description: string }>((desde, hasta) =>
      cliente
        .from("controls")
        .select("id, holder_id, description")
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("id")
        .range(desde, hasta),
    ),
    fetchAll<Boton>((desde, hasta) =>
      cliente
        .from("control_buttons")
        .select(BOTON_COLUMNAS)
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("control_id")
        .order("button")
        .range(desde, hasta),
    ),
    holderNames(cliente, installationId),
  ]);

  const porControl = new Map<string, ButtonRow[]>();
  for (const b of botones) {
    const lista = porControl.get(b.control_id) ?? [];
    lista.push({ button: b.button, rf_code: b.rf_code, output_index: b.output_index });
    porControl.set(b.control_id, lista);
  }
  return controles
    .map((c) => ({
      ...c,
      holder_name: nombres.get(c.holder_id) ?? "",
      buttons: porControl.get(c.id) ?? [],
    }))
    .sort((a, b) => a.holder_name.localeCompare(b.holder_name, "es") || a.description.localeCompare(b.description, "es"));
}

/** Crea un control con sus botones. */
export async function createControlAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  entrada: ControlInput,
): Promise<{ id: string }> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const holderId = await requireHolder(cliente, installationId, entrada?.holder_id);
  const usados = parseButtons(entrada.buttons);
  await checkRfFree(cliente, installationId, usados.map((u) => u.rf_code), null);

  const { data: control, error } = await cliente
    .from("controls")
    .insert({ installation_id: installationId, holder_id: holderId, description: descripcionDe(entrada.description) })
    .select("id")
    .single<{ id: string }>();
  if (error) traducir(error);
  if (usados.length === 0) return control;

  const { error: errorBotones } = await cliente
    .from("control_buttons")
    .insert(usados.map((u) => ({ installation_id: installationId, control_id: control.id, ...u })));
  if (errorBotones) {
    // No dejar un control vivo sin sus botones.
    await cliente.from("controls").update({ deleted_at: new Date().toISOString() }).eq("id", control.id);
    traducir(errorBotones);
  }
  return control;
}

/**
 * Edita titular, descripción y botones. Un botón con otro código se reemplaza (borrado
 * lógico + alta nueva, así se pueden intercambiar códigos); si solo cambia la salida se
 * actualiza en su sitio; un botón sin código se borra.
 */
export async function updateControlAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  controlId: string,
  entrada: ControlInput,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "El control no existe.");
  if (!esUuid(controlId)) throw noExiste;
  const holderId = await requireHolder(cliente, installationId, entrada?.holder_id);
  const usados = parseButtons(entrada.buttons);
  await checkRfFree(cliente, installationId, usados.map((u) => u.rf_code), controlId);

  const { data: filas, error: errorControl } = await cliente
    .from("controls")
    .update({ holder_id: holderId, description: descripcionDe(entrada.description) })
    .eq("id", controlId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (errorControl) traducir(errorControl);
  if (filas.length === 0) throw noExiste;

  const { data: actuales, error: errorActuales } = await cliente
    .from("control_buttons")
    .select(BOTON_COLUMNAS)
    .eq("control_id", controlId)
    .is("deleted_at", null);
  if (errorActuales) throw errorActuales;
  const porPosicion = new Map((actuales as Boton[]).map((b) => [b.button, b]));

  const borrar: string[] = [];
  const cambiarSalida: Array<{ id: string; output_index: number | null }> = [];
  const alta: Array<{ button: number; rf_code: number; output_index: number | null }> = [];
  for (let button = 0; button < BUTTON_COUNT; button++) {
    const actual = porPosicion.get(button);
    const deseado = usados.find((u) => u.button === button);
    if (!deseado) {
      if (actual) borrar.push(actual.id);
    } else if (!actual) {
      alta.push(deseado);
    } else if (actual.rf_code !== deseado.rf_code) {
      borrar.push(actual.id);
      alta.push(deseado);
    } else if (actual.output_index !== deseado.output_index) {
      cambiarSalida.push({ id: actual.id, output_index: deseado.output_index });
    }
  }

  if (borrar.length > 0) {
    const { error } = await cliente
      .from("control_buttons")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", borrar);
    if (error) throw error;
  }
  for (const c of cambiarSalida) {
    const { error } = await cliente.from("control_buttons").update({ output_index: c.output_index }).eq("id", c.id);
    if (error) throw error;
  }
  if (alta.length > 0) {
    const { error } = await cliente
      .from("control_buttons")
      .insert(alta.map((u) => ({ installation_id: installationId, control_id: controlId, ...u })));
    if (error) traducir(error);
  }
}

/** Borrado lógico del control; el trigger lo extiende a sus botones (libera los RF). */
export async function deleteControlAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  controlId: string,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "El control no existe.");
  if (!esUuid(controlId)) throw noExiste;
  const { data, error } = await cliente
    .from("controls")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", controlId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw noExiste;
}
