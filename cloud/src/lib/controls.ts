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
import { BUTTON_COUNT, CODE_MESSAGE, KEEP_NO_OUTPUT, MAX_CODE, OUTPUT_COUNT, rfTakenMessage } from "@/lib/access-view";
import { HttpError } from "@/lib/errors";
import { isLinkedPanel } from "@/lib/profile-view";

/**
 * Controles RF de una instalación como el usuario de la sesión (RLS). Cada control tiene
 * botones (`button` 0..3) con su código RF decimal; la salida que abre cada botón se elige
 * POR PANEL en `control_button_panels` (un vínculo vivo por botón y panel, `output_index`
 * 0..3 o nulo). "Ninguna" en la interfaz es no tener vínculo con ese panel; "Sin salida"
 * conserva un vínculo nulo que ya existe (lo crea un panel). Un botón sin vínculos hacia
 * paneles vinculados no hace nada: no se crea o se borra. El número de botón es único por
 * panel: dos botones vivos del mismo control pueden compartirlo si van a paneles distintos.
 * PostgREST no ofrece transacciones: antes de escribir se valida todo (incluidas la
 * unicidad del RF y la del número por panel) y las escrituras van en un orden que no deja
 * choques intermedios; un alta que falla al crear se compensa borrando el control.
 */

export interface ButtonInput {
  /** Botón existente; null = botón nuevo. */
  id: string | null;
  button: number;
  /** null en un botón existente = borrarlo; en uno nuevo, se ignora. */
  rf_code: number | null;
  /**
   * Salida por panel: `panel_id` → 0..3; null = "Ninguna" (sin vínculo: se borra si existe);
   * `KEEP_NO_OUTPUT` = "Sin salida" (conserva el vínculo nulo que ya existe; si no existe, 400).
   * Los paneles que no vienen no se tocan.
   */
  outputs: Record<string, number | null | typeof KEEP_NO_OUTPUT>;
}

export interface ControlInput {
  holder_id: string;
  description: string;
  /** De 0 a `MAX_BUTTONS` botones. Los botones existentes que no vienen no se tocan. */
  buttons: ButtonInput[];
}

export interface ButtonRow {
  id: string;
  button: number;
  rf_code: number;
  /** Vínculos vivos del botón: `panel_id` → salida (null = el panel lo tiene sin salida). */
  outputs: Record<string, number | null>;
}

export interface ControlRow {
  id: string;
  holder_id: string;
  holder_name: string;
  description: string;
  buttons: ButtonRow[];
}

/** Hasta dos botones por número (4 números) caben en un formulario. */
export const MAX_BUTTONS = 8;

interface Boton {
  id: string;
  control_id: string;
  button: number;
  rf_code: number;
}

interface Vinculo {
  id: string;
  button_id: string;
  panel_id: string;
  output_index: number | null;
}

interface Pedido {
  id: string | null;
  button: number;
  rf_code: number | null;
  outputs: Map<string, number | null | typeof KEEP_NO_OUTPUT>;
}

const BOTON_COLUMNAS = "id, control_id, button, rf_code";
const VINCULO_COLUMNAS = "id, button_id, panel_id, output_index";
const DATOS_INVALIDOS = "Datos inválidos.";
const PANEL_INVALIDO = "El panel no existe o ya no está vinculado.";
const BOTON_NO_EXISTE = "Uno de los botones ya no existe. Recarga la página.";
const SIN_SALIDA_INVALIDA = "Sin salida solo se puede conservar en un panel que ya tiene el botón sin salida.";
const CONTROL_CAMBIO = "El control cambió mientras lo editabas. Recarga la página.";
const ahora = () => new Date().toISOString();

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Valida la forma de los botones pedidos (los paneles se validan después contra la base). */
function parseButtons(botones: unknown): Pedido[] {
  if (!Array.isArray(botones)) throw new HttpError(400, DATOS_INVALIDOS);
  if (botones.length > MAX_BUTTONS) throw new HttpError(400, `El control admite hasta ${MAX_BUTTONS} botones.`);
  const pedidos = botones.map((b: unknown): Pedido => {
    if (!esObjeto(b)) throw new HttpError(400, DATOS_INVALIDOS);
    const id = b.id ?? null;
    if (id !== null && !esUuid(id)) throw new HttpError(400, DATOS_INVALIDOS);
    const button = b.button;
    if (!Number.isInteger(button) || (button as number) < 0 || (button as number) >= BUTTON_COUNT) {
      throw new HttpError(400, `El número de botón debe ser del 1 al ${BUTTON_COUNT}.`);
    }
    const rf = b.rf_code ?? null;
    if (rf !== null && (!Number.isSafeInteger(rf) || (rf as number) < 0 || (rf as number) > MAX_CODE)) {
      throw new HttpError(400, CODE_MESSAGE);
    }
    const salidas = b.outputs ?? {};
    if (!esObjeto(salidas)) throw new HttpError(400, DATOS_INVALIDOS);
    const outputs: Pedido["outputs"] = new Map();
    for (const [panelId, o] of Object.entries(salidas)) {
      const valida =
        o === null || o === KEEP_NO_OUTPUT || (Number.isInteger(o) && (o as number) >= 0 && (o as number) < OUTPUT_COUNT);
      if (!valida) throw new HttpError(400, `La salida debe ser de S1 a S${OUTPUT_COUNT}.`);
      if (!esUuid(panelId)) throw new HttpError(400, PANEL_INVALIDO);
      outputs.set(panelId, o as number | null | typeof KEEP_NO_OUTPUT);
    }
    return { id: id as string | null, button: button as number, rf_code: rf as number | null, outputs };
  });
  const ids = pedidos.flatMap((p) => (p.id === null ? [] : [p.id]));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, DATOS_INVALIDOS);
  const codigos = pedidos.flatMap((p) => (p.rf_code === null ? [] : [p.rf_code]));
  if (new Set(codigos).size !== codigos.length) {
    throw new HttpError(400, "Cada botón del control debe tener un código distinto.");
  }
  return pedidos;
}

interface PanelInfo {
  code: string;
  /** Vinculado a la instalación (ni pendiente ni revocado). */
  linked: boolean;
}

/**
 * Código y estado de los paneles pedidos y de los que ya tienen vínculos. Los pedidos deben
 * ser paneles vinculados de la instalación.
 */
async function panelInfo(
  cliente: SupabaseClient,
  installationId: string,
  pedidos: Pedido[],
  otros: Iterable<string> = [],
): Promise<Map<string, PanelInfo>> {
  const pedidosIds = new Set(pedidos.flatMap((p) => [...p.outputs.keys()]));
  const todos = new Set([...pedidosIds, ...otros]);
  if (todos.size === 0) return new Map();
  const { data, error } = await cliente
    .from("panels")
    .select("id, panel_code, status")
    .eq("installation_id", installationId)
    .in("id", [...todos]);
  if (error) throw error;
  const paneles = new Map(
    (data as { id: string; panel_code: string; status: string }[]).map((p) => [
      p.id,
      { code: p.panel_code, linked: isLinkedPanel(p) },
    ]),
  );
  for (const id of pedidosIds) if (!paneles.get(id)?.linked) throw new HttpError(400, PANEL_INVALIDO);
  return paneles;
}

/** Estado final de un botón: número, código y vínculos por panel (salida o null). */
interface Final {
  button: number;
  rf_code: number;
  links: Map<string, number | null>;
}

/** Vínculos hacia paneles vinculados; los de paneles revocados no cuentan ni se recrean. */
const vinculosVigentes = (links: Map<string, number | null>, paneles: Map<string, PanelInfo>) =>
  new Map([...links].filter(([panelId]) => paneles.get(panelId)?.linked));

/** 400 si dos botones vivos con el mismo número quedarían vinculados al mismo panel. */
function checkPanelNumbers(finales: Final[], paneles: Map<string, PanelInfo>): void {
  const vistos = new Set<string>();
  for (const f of finales) {
    for (const panelId of f.links.keys()) {
      const clave = `${panelId}:${f.button}`;
      if (vistos.has(clave)) {
        throw new HttpError(
          400,
          `Dos botones con el número ${f.button + 1} van al panel ${paneles.get(panelId)?.code ?? "elegido"}.`,
        );
      }
      vistos.add(clave);
    }
  }
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

/**
 * Errores de la base en español. `padre` es el texto cuando lo que falta es el registro
 * padre (23503): el titular al escribir el control, el control al escribir botones, o el
 * botón o el panel al escribir vínculos.
 */
export function traducir(
  error: { code?: string; message?: string; details?: string | null },
  padre = HOLDER_GONE,
): never {
  if (isUniqueViolation(error, "control_buttons_rf_code_live_key")) {
    throw new HttpError(409, "Uno de los códigos ya está registrado en otro control.");
  }
  if (isUniqueViolation(error, "control_button_panels_panel_button_live_key")) {
    throw new HttpError(409, "Otro botón de este control ya usa ese número en el mismo panel. Recarga la página.");
  }
  if (isUniqueViolation(error, "control_button_panels_button_panel_live_key")) throw new HttpError(409, CONTROL_CAMBIO);
  if (isMissingParent(error)) throw new HttpError(409, padre);
  throw error;
}
const CONTROL_GONE = "El control ya no existe.";
const VINCULO_GONE = "El botón o el panel ya no existe. Recarga la página.";

/** Controles vivos con titular, botones y salida por panel, por titular y descripción. */
export async function listControlsAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
): Promise<ControlRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const [controles, botones, vinculos, nombres] = await Promise.all([
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
        .order("id")
        .range(desde, hasta),
    ),
    fetchAll<Vinculo>((desde, hasta) =>
      cliente
        .from("control_button_panels")
        .select(VINCULO_COLUMNAS)
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("id")
        .range(desde, hasta),
    ),
    holderNames(cliente, installationId),
  ]);

  const salidas = new Map<string, Record<string, number | null>>();
  for (const v of vinculos) {
    const porPanel = salidas.get(v.button_id) ?? {};
    porPanel[v.panel_id] = v.output_index;
    salidas.set(v.button_id, porPanel);
  }
  const porControl = new Map<string, ButtonRow[]>();
  for (const b of botones) {
    const lista = porControl.get(b.control_id) ?? [];
    lista.push({ id: b.id, button: b.button, rf_code: b.rf_code, outputs: salidas.get(b.id) ?? {} });
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

/** Vínculos de un botón nuevo: solo los paneles con salida elegida ("Sin salida" no cabe: no hay vínculo). */
function vinculosNuevos(p: Pedido): Map<string, number | null> {
  const links = new Map<string, number | null>();
  for (const [panelId, o] of p.outputs) {
    if (o === KEEP_NO_OUTPUT) throw new HttpError(400, SIN_SALIDA_INVALIDA);
    if (o !== null) links.set(panelId, o);
  }
  return links;
}

/** Inserta botones nuevos del control y sus vínculos. */
async function insertarBotones(
  cliente: SupabaseClient,
  installationId: string,
  controlId: string,
  altas: Final[],
): Promise<void> {
  if (altas.length === 0) return;
  const { data, error } = await cliente
    .from("control_buttons")
    .insert(altas.map((a) => ({ installation_id: installationId, control_id: controlId, button: a.button, rf_code: a.rf_code })))
    .select("id, rf_code");
  if (error) traducir(error, CONTROL_GONE);
  // El código es único entre los botones vivos: identifica a cada alta.
  const idPorCodigo = new Map((data as { id: string; rf_code: number }[]).map((b) => [b.rf_code, b.id]));
  const filas = altas.flatMap((a) =>
    [...a.links].map(([panelId, output_index]) => ({
      installation_id: installationId,
      button_id: idPorCodigo.get(a.rf_code),
      panel_id: panelId,
      output_index,
    })),
  );
  if (filas.length === 0) return;
  const { error: errorVinculos } = await cliente.from("control_button_panels").insert(filas);
  if (errorVinculos) traducir(errorVinculos, VINCULO_GONE);
}

/** Crea un control con sus botones; un botón sin salida en ningún panel no se crea. */
export async function createControlAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  entrada: ControlInput,
): Promise<{ id: string }> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const holderId = await requireHolder(cliente, installationId, entrada?.holder_id);
  const pedidos = parseButtons(entrada.buttons);
  if (pedidos.some((p) => p.id !== null)) throw new HttpError(400, DATOS_INVALIDOS);
  const paneles = await panelInfo(cliente, installationId, pedidos);
  const altas = pedidos.flatMap((p): Final[] => {
    const links = vinculosNuevos(p);
    return p.rf_code === null || links.size === 0 ? [] : [{ button: p.button, rf_code: p.rf_code, links }];
  });
  checkPanelNumbers(altas, paneles);
  await checkRfFree(cliente, installationId, altas.map((a) => a.rf_code), null);

  const { data: control, error } = await cliente
    .from("controls")
    .insert({ installation_id: installationId, holder_id: holderId, description: descripcionDe(entrada.description) })
    .select("id")
    .single<{ id: string }>();
  if (error) traducir(error);
  try {
    await insertarBotones(cliente, installationId, control.id, altas);
  } catch (e) {
    // No dejar un control vivo sin sus botones (la cascada lógica borra lo que sí se creó).
    const { error: errorCompensa } = await cliente.from("controls").update({ deleted_at: ahora() }).eq("id", control.id);
    if (errorCompensa) {
      console.error("No se pudo borrar el control a medias tras un alta fallida:", control.id, errorCompensa.message);
    }
    throw e;
  }
  return control;
}

/**
 * Edita titular, descripción y botones. Cada botón existente se identifica por su id:
 * - por cada panel pedido se inserta el vínculo, se cambia su salida, se borra ("Ninguna")
 *   o se conserva sin salida ("Sin salida", solo si ya existía así);
 * - sin código, o sin vínculos hacia paneles vinculados, se borra (la cascada borra sus vínculos);
 * - si cambia el código, se actualiza su fila (los intercambios se ordenan para no chocar).
 * Los botones nuevos se crean con sus vínculos. Botones y paneles que no vienen no se tocan.
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
  const pedidos = parseButtons(entrada.buttons);

  const { data: vivo, error: errorVivo } = await cliente
    .from("controls")
    .select("id")
    .eq("id", controlId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (errorVivo) throw errorVivo;
  if (!vivo) throw noExiste;

  const { data: actuales, error: errorActuales } = await cliente
    .from("control_buttons")
    .select(BOTON_COLUMNAS)
    .eq("control_id", controlId)
    .is("deleted_at", null);
  if (errorActuales) throw errorActuales;
  const botones = new Map((actuales as Boton[]).map((b) => [b.id, b]));
  const vinculos = new Map<string, Map<string, Vinculo>>();
  if (botones.size > 0) {
    const { data, error } = await cliente
      .from("control_button_panels")
      .select(VINCULO_COLUMNAS)
      .in("button_id", [...botones.keys()])
      .is("deleted_at", null);
    if (error) throw error;
    for (const v of data as Vinculo[]) {
      const porPanel = vinculos.get(v.button_id) ?? new Map<string, Vinculo>();
      porPanel.set(v.panel_id, v);
      vinculos.set(v.button_id, porPanel);
    }
  }
  const paneles = await panelInfo(
    cliente,
    installationId,
    pedidos,
    [...vinculos.values()].flatMap((m) => [...m.keys()]),
  );

  // Plan de escritura, calculado completo antes de escribir.
  const borrarBotones: string[] = [];
  const cambiosCodigo: Array<{ id: string; antes: number; despues: number; final: Final }> = [];
  const borrarVinculos: Array<{ id: string; button_id: string }> = [];
  const cambiarVinculos: Array<{ id: string; button_id: string; output_index: number }> = [];
  const nuevosVinculos: Array<{ button_id: string; panel_id: string; output_index: number }> = [];
  const altas: Final[] = [];
  const finales: Final[] = [];

  const pedidosPorId = new Map(pedidos.flatMap((p) => (p.id === null ? [] : [[p.id, p] as const])));
  for (const id of pedidosPorId.keys()) if (!botones.has(id)) throw new HttpError(409, BOTON_NO_EXISTE);

  for (const b of botones.values()) {
    const actualesB = vinculos.get(b.id) ?? new Map<string, Vinculo>();
    const links = new Map([...actualesB].map(([panelId, v]) => [panelId, v.output_index]));
    const p = pedidosPorId.get(b.id);
    if (!p) {
      finales.push({ button: b.button, rf_code: b.rf_code, links });
      continue;
    }
    if (p.button !== b.button) throw new HttpError(400, "El número de un botón existente no se puede cambiar.");
    for (const [panelId, o] of p.outputs) {
      if (o === KEEP_NO_OUTPUT) {
        if (links.get(panelId) !== null) throw new HttpError(400, SIN_SALIDA_INVALIDA);
      } else if (o === null) links.delete(panelId);
      else links.set(panelId, o);
    }
    if (p.rf_code === null || vinculosVigentes(links, paneles).size === 0) {
      borrarBotones.push(b.id);
      continue;
    }
    const final: Final = { button: b.button, rf_code: p.rf_code, links };
    finales.push(final);
    if (p.rf_code !== b.rf_code) cambiosCodigo.push({ id: b.id, antes: b.rf_code, despues: p.rf_code, final });
    for (const [panelId, v] of actualesB) {
      if (!links.has(panelId)) borrarVinculos.push({ id: v.id, button_id: b.id });
    }
    for (const [panelId, o] of links) {
      const v = actualesB.get(panelId);
      if (!v) nuevosVinculos.push({ button_id: b.id, panel_id: panelId, output_index: o as number });
      else if (v.output_index !== o) cambiarVinculos.push({ id: v.id, button_id: b.id, output_index: o as number });
    }
  }
  for (const p of pedidos) {
    if (p.id !== null || p.rf_code === null) continue;
    const links = vinculosNuevos(p);
    if (links.size === 0) continue;
    const final: Final = { button: p.button, rf_code: p.rf_code, links };
    altas.push(final);
    finales.push(final);
  }
  const finalesRf = finales.map((f) => f.rf_code);
  if (new Set(finalesRf).size !== finalesRf.length) {
    throw new HttpError(400, "Cada botón del control debe tener un código distinto.");
  }
  checkPanelNumbers(finales, paneles);
  await checkRfFree(cliente, installationId, finalesRf, controlId);

  const { data: filas, error: errorControl } = await cliente
    .from("controls")
    .update({ holder_id: holderId, description: descripcionDe(entrada.description) })
    .eq("id", controlId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (errorControl) traducir(errorControl);
  if (filas.length === 0) throw noExiste;

  const borrarBoton = async (ids: string[]) => {
    if (ids.length === 0) return;
    const { error } = await cliente.from("control_buttons").update({ deleted_at: ahora() }).in("id", ids);
    if (error) throw error;
  };
  await borrarBoton(borrarBotones);

  // Cambios de código: primero los que van a un código libre; un intercambio (ciclo) se
  // rompe borrando uno de los botones y dándolo de alta otra vez con su código nuevo.
  const codigoActual = new Map(cambiosCodigo.map((c) => [c.final, c.antes]));
  const ocupados = new Set(finales.filter((f) => !altas.includes(f)).map((f) => codigoActual.get(f) ?? f.rf_code));
  const recreados = new Set<string>();
  const pendientes = [...cambiosCodigo];
  while (pendientes.length > 0) {
    const i = pendientes.findIndex((c) => !ocupados.has(c.despues));
    if (i === -1) {
      const c = pendientes.shift()!;
      await borrarBoton([c.id]);
      ocupados.delete(c.antes);
      // Se recrea solo con sus vínculos hacia paneles vinculados.
      altas.push({ ...c.final, links: vinculosVigentes(c.final.links, paneles) });
      recreados.add(c.id);
      continue;
    }
    const [c] = pendientes.splice(i, 1);
    const { error } = await cliente.from("control_buttons").update({ rf_code: c.despues }).eq("id", c.id).is("deleted_at", null);
    if (error) traducir(error, CONTROL_GONE);
    ocupados.delete(c.antes);
    ocupados.add(c.despues);
  }

  // Los vínculos de un botón recreado ya se borraron con él; los nuevos se crean con su alta.
  const vigente = (v: { button_id: string }) => !recreados.has(v.button_id);
  const borrar = borrarVinculos.filter(vigente).map((v) => v.id);
  if (borrar.length > 0) {
    const { error } = await cliente
      .from("control_button_panels")
      .update({ deleted_at: ahora() })
      .in("id", borrar)
      .is("deleted_at", null);
    if (error) throw error;
  }
  for (const v of cambiarVinculos.filter(vigente)) {
    const { error } = await cliente
      .from("control_button_panels")
      .update({ output_index: v.output_index })
      .eq("id", v.id)
      .is("deleted_at", null);
    if (error) throw error;
  }
  const insertar = nuevosVinculos.filter(vigente);
  if (insertar.length > 0) {
    const { error } = await cliente
      .from("control_button_panels")
      .insert(insertar.map((v) => ({ installation_id: installationId, ...v })));
    if (error) traducir(error, VINCULO_GONE);
  }
  await insertarBotones(cliente, installationId, controlId, altas);
}

/** Borrado lógico del control; el trigger lo extiende a sus botones y vínculos (libera los RF). */
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
    .update({ deleted_at: ahora() })
    .eq("id", controlId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw noExiste;
}
