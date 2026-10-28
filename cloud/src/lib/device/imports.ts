import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireTenantRole, requireUser, type TenantRole } from "@/lib/auth/guards";
import { encryptPin, pinLookup } from "@/lib/crypto";
import { retryOnDeadlock } from "@/lib/device/apply";
import type { Panel } from "@/lib/device/auth";
import { readInstallationRevision } from "@/lib/device/changes";
import {
  MAX_SNAPSHOT_ROWS,
  TABLES,
  type ContractRow,
  type HolderData,
  type PermissionData,
  type SnapshotTables,
} from "@/lib/device/contract";
import { IMPORT_STALE_MESSAGE, NO_PENDING_IMPORT_MESSAGE } from "@/lib/device/import-messages";
import { DeviceApiError } from "@/lib/device/http";
import { HttpError } from "@/lib/errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Importación al vincular (`POST /import-snapshot` y la revisión de un administrador).
 *
 * Un panel recién vinculado (`staging`) sube su base local:
 * - si la instalación no tiene datos vivos (holders, cards, controls ni access_profiles),
 *   se importa entera como cambios del panel, con sus UUID, y el panel queda `active`;
 * - si tiene datos, se guarda el snapshot (con el PIN cifrado) y su diff en
 *   `panel_imports`, y el panel queda `awaiting_review` hasta que un administrador elige
 *   qué importar (`confirmImportAs`).
 *
 * Node valida el snapshot, cifra el PIN, calcula el diff (`computeImportDiff`, pura) y
 * arma el plan; las funciones SQL de 0004 lo escriben en una transacción (RPC con la
 * llave secreta). Un UUID del panel que ya existe en la nube recibe uno nuevo (Riesgo 4).
 */

/** Máximo de perfiles de acceso por instalación (`local_permission_id` 0..31). */
export const MAX_PROFILES = 32;
/** Máximo de IDs seleccionados en `confirmImport` (titulares, tarjetas y controles). */
export const MAX_SELECTED_IDS = 3 * MAX_SNAPSHOT_ROWS;

const MAXIMO_PERFILES = `Máximo ${MAX_PROFILES} perfiles por instalación.`;
const PIN_DE_OTRO = "El PIN ya lo usa otro titular de la instalación.";
const OTRO_PIN = "El titular ya tiene otro PIN en la plataforma.";
const SIN_IMPORTACION = NO_PENDING_IMPORT_MESSAGE;
/** Veces que `confirmImportAs` rearma el plan si la instalación cambió mientras tanto. */
const INTENTOS_CONFIRMAR = 3;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Titular como se guarda en `panel_imports`: el PIN cifrado con su `pin_lookup`, nunca en claro. */
export type StoredHolderData = Omit<HolderData, "pin"> & {
  pin_ciphertext: string | null;
  pin_lookup: string | null;
};

/** Snapshot del panel como se guarda en `panel_imports.snapshot`. */
export type StoredSnapshot = Omit<SnapshotTables, "holders"> & {
  holders: { id: string; data: StoredHolderData }[];
};

/** Lo que `computeImportDiff` necesita de la nube: filas vivas de la instalación. */
export interface CloudState {
  holders: { id: string; kind: HolderData["kind"]; name: string; pin_lookup: string | null }[];
  cards: { id: string; card_code: number; holder_id: string }[];
  controls: { id: string; holder_id: string }[];
  control_buttons: { id: string; control_id: string; button: number; rf_code: number }[];
  access_profiles: { id: string; local_permission_id: number }[];
  holder_profiles: { id: string; holder_id: string; profile_id: string }[];
}

export interface ImportCardSummary {
  id: string;
  card_code: number;
  description: string;
}

export interface ImportButtonSummary {
  id: string;
  button: number;
  rf_code: number;
  output_id: number | null;
}

export interface ImportControlSummary {
  id: string;
  description: string;
  buttons: ImportButtonSummary[];
}

/**
 * Algo que solo tiene el panel y se puede importar; `id` es el UUID del panel y es lo
 * que se selecciona en `confirmImport`.
 * - `holder`: titular que la nube no tiene, con sus tarjetas, controles y PIN que se
 *   pueden importar (lo que choca va en `conflicts`); se importa todo junto.
 * - `card`, `control` y `pin`: de un titular que la nube ya tiene (`holder_name` es el
 *   nombre en la nube); `pin.id` es el id del titular en el panel.
 * - `button`: botón con un código RF que la nube no tiene, de un control que la nube ya
 *   tiene en ese titular; se agrega a ese control.
 */
export type ImportItem =
  | {
      type: "holder";
      id: string;
      kind: HolderData["kind"];
      name: string;
      department: string;
      has_pin: boolean;
      cards: ImportCardSummary[];
      controls: ImportControlSummary[];
    }
  | { type: "card"; id: string; holder_name: string; card_code: number; description: string }
  | { type: "control"; id: string; holder_name: string; description: string; buttons: ImportButtonSummary[] }
  | ({ type: "button"; holder_name: string; control_description: string } & ImportButtonSummary)
  | { type: "pin"; id: string; holder_name: string };

/** Algo del panel que no se importa; `holder_name` es el nombre del titular en el panel. */
export type ImportConflict =
  | { type: "pin"; id: string; holder_name: string; reason: string }
  | { type: "card"; id: string; holder_name: string; card_code: number; reason: string }
  | { type: "control_button"; id: string; holder_name: string; rf_code: number; reason: string }
  | { type: "permission"; id: string; permission_id: number; name: string; reason: string };

/** Diff de una importación. Nunca trae el PIN, su cifrado ni su `pin_lookup`. */
export interface ImportDiff {
  onlyInPanel: ImportItem[];
  conflicts: ImportConflict[];
}

/** Resultado de `confirmImport`: IDs seleccionados que se importaron y los que no (ya no se podían). */
export interface ConfirmImportResult {
  imported: string[];
  ignored: string[];
}

/** Plan de importación con columnas de la nube (lo escribe `private.import_rows`). */
interface ImportPlan {
  holders: ({ id: string } & StoredHolderData)[];
  holder_pins: { holder_id: string; pin_ciphertext: string; pin_lookup: string }[];
  cards: { id: string; card_code: number; holder_id: string; description: string }[];
  controls: { id: string; holder_id: string; description: string }[];
  control_buttons: { id: string; control_id: string; button: number; rf_code: number; output_index: number | null }[];
  access_profiles: ({ id: string; name: string; local_permission_id: number } & Omit<
    PermissionData,
    "permission_id" | "name"
  >)[];
  holder_profiles: { id: string; holder_id: string; profile_id: string }[];
  outputs: {
    id: string;
    output_index: number;
    alias: string;
    duration_ms: number;
    reader_mask: number;
    enabled: boolean;
  }[];
}

// ---------------------------------------------------------------------------
// Validación y preparación del snapshot (puras)
// ---------------------------------------------------------------------------

/** Primer valor repetido de una lista, o `undefined`. */
function primeroRepetido<T>(valores: Iterable<T>): T | undefined {
  const vistos = new Set<T>();
  for (const v of valores) {
    if (vistos.has(v)) return v;
    vistos.add(v);
  }
  return undefined;
}

/**
 * Revisa la coherencia interna de un snapshot ya validado con los `dataSchemas`: ids
 * únicos por tabla, referencias por UUID (y por `permission_id`) que existen en el propio
 * snapshot y los valores únicos de la base local (tarjeta, código RF, PIN, botón por
 * control, permiso, asignación y salida). Devuelve el primer problema en español (sin
 * el PIN), o `null`.
 */
export function snapshotProblem(t: SnapshotTables): string | null {
  for (const tabla of TABLES) {
    const id = primeroRepetido<string>(t[tabla].map((f) => f.id));
    if (id !== undefined) return `Identificador repetido en ${tabla}: ${id}.`;
  }
  const titulares = new Set(t.holders.map((h) => h.id));
  const controles = new Set(t.controls.map((c) => c.id));
  const permisos = new Set(t.permissions.map((p) => p.data.permission_id));

  if (primeroRepetido(t.holders.flatMap((h) => (h.data.pin === null ? [] : [h.data.pin]))) !== undefined) {
    return "PIN repetido entre titulares.";
  }
  for (const k of t.cards) {
    if (!titulares.has(k.data.holder_id)) return `La tarjeta ${k.id} apunta a un titular que no está en el snapshot.`;
  }
  const tarjeta = primeroRepetido(t.cards.map((k) => k.data.card_code));
  if (tarjeta !== undefined) return `Código de tarjeta repetido: ${tarjeta}.`;
  for (const c of t.controls) {
    if (!titulares.has(c.data.holder_id)) return `El control ${c.id} apunta a un titular que no está en el snapshot.`;
  }
  for (const b of t.control_buttons) {
    if (!controles.has(b.data.control_id)) return `El botón ${b.id} apunta a un control que no está en el snapshot.`;
  }
  const rf = primeroRepetido(t.control_buttons.map((b) => b.data.rf_code));
  if (rf !== undefined) return `Código RF repetido: ${rf}.`;
  const boton = primeroRepetido(t.control_buttons.map((b) => `${b.data.control_id} ${b.data.button}`));
  if (boton !== undefined) return `Botón repetido en un control: ${boton}.`;
  const permiso = primeroRepetido(t.permissions.map((p) => p.data.permission_id));
  if (permiso !== undefined) return `permission_id repetido: ${permiso}.`;
  for (const a of t.holder_permissions) {
    if (!titulares.has(a.data.holder_id)) return `La asignación ${a.id} apunta a un titular que no está en el snapshot.`;
    if (!permisos.has(a.data.permission_id)) {
      return `La asignación ${a.id} apunta a un permiso que no está en el snapshot.`;
    }
  }
  const asignacion = primeroRepetido(t.holder_permissions.map((a) => `${a.data.holder_id} ${a.data.permission_id}`));
  if (asignacion !== undefined) return `Asignación repetida: ${asignacion}.`;
  const salida = primeroRepetido(t.outputs.map((o) => o.data.output_id));
  if (salida !== undefined) return `output_id repetido: ${salida}.`;
  return null;
}

/** Reemplaza el PIN de cada titular por su cifrado y su `pin_lookup` (de la instalación). */
export function protectSnapshot(installationId: string, tables: SnapshotTables): StoredSnapshot {
  return {
    ...tables,
    holders: tables.holders.map(({ id, data: { pin, ...resto } }) => ({
      id,
      data: {
        ...resto,
        pin_ciphertext: pin === null ? null : encryptPin(pin),
        pin_lookup: pin === null ? null : pinLookup(installationId, pin),
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Diff (puro)
// ---------------------------------------------------------------------------

type CloudHolder = CloudState["holders"][number];
type HolderItem = Extract<ImportItem, { type: "holder" }>;

interface Analisis {
  diff: ImportDiff;
  /** Titular de la nube que corresponde a cada titular del panel que la nube ya tiene. */
  titularDe: Map<string, string>;
  /** `local_permission_id` libre de cada permiso del panel que se vuelve perfil nuevo. */
  perfilesNuevos: Map<string, number>;
  /** Control de la nube al que se agrega cada botón ofrecido como `button`. */
  destinoDeBoton: Map<string, string>;
}

const claveTitular = (kind: string, name: string) => `${kind}\n${name.trim().toLowerCase()}`;
const porIdAsc = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function agruparPor<T, K>(filas: readonly T[], clave: (f: T) => K): Map<K, T[]> {
  const grupos = new Map<K, T[]>();
  for (const f of filas) {
    const k = clave(f);
    const grupo = grupos.get(k);
    if (grupo) grupo.push(f);
    else grupos.set(k, [f]);
  }
  return grupos;
}

function analizar(nube: CloudState, snap: StoredSnapshot): Analisis {
  const onlyInPanel: ImportItem[] = [];
  const conflicts: ImportConflict[] = [];

  // Titulares: el mismo UUID vivo en la instalación, o el mismo kind y nombre (sin
  // distinguir mayúsculas ni espacios en los extremos; con varios, el de menor id).
  const titularNube = new Map(nube.holders.map((h) => [h.id, h]));
  const porNombre = new Map<string, CloudHolder>();
  for (const h of [...nube.holders].sort(porIdAsc)) {
    const k = claveTitular(h.kind, h.name);
    if (!porNombre.has(k)) porNombre.set(k, h);
  }
  const titularDe = new Map<string, string>();
  for (const h of snap.holders) {
    const m = titularNube.get(h.id) ?? porNombre.get(claveTitular(h.data.kind, h.data.name));
    if (m) titularDe.set(h.id, m.id);
  }
  const nombreNube = (id: string | undefined) => (id === undefined ? "" : (titularNube.get(id)?.name ?? ""));
  const nombrePanel = new Map(snap.holders.map((h) => [h.id, h.data.name]));

  // PIN por pin_lookup. Solo agrega: un titular de la nube con otro PIN no se cambia.
  const duenoPin = new Map(nube.holders.flatMap((h) => (h.pin_lookup === null ? [] : [[h.pin_lookup, h.id] as const])));
  const nuevos = new Map<string, HolderItem>();
  // Titulares de la nube que ya recibirán un PIN de esta importación (dos titulares del
  // panel pueden emparejarse con el mismo de la nube).
  const conPinNuevo = new Set<string>();
  for (const h of snap.holders) {
    const m = titularDe.get(h.id);
    let pinLibre = false;
    if (h.data.pin_lookup !== null) {
      const dueno = duenoPin.get(h.data.pin_lookup);
      if (dueno !== undefined) {
        if (dueno !== m) conflicts.push({ type: "pin", id: h.id, holder_name: h.data.name, reason: PIN_DE_OTRO });
      } else if (m !== undefined && (titularNube.get(m)!.pin_lookup !== null || conPinNuevo.has(m))) {
        conflicts.push({ type: "pin", id: h.id, holder_name: h.data.name, reason: OTRO_PIN });
      } else {
        pinLibre = true;
      }
    }
    if (m !== undefined) {
      if (pinLibre) {
        conPinNuevo.add(m);
        onlyInPanel.push({ type: "pin", id: h.id, holder_name: nombreNube(m) });
      }
      continue;
    }
    const item: HolderItem = {
      type: "holder",
      id: h.id,
      kind: h.data.kind,
      name: h.data.name,
      department: h.data.department,
      has_pin: pinLibre,
      cards: [],
      controls: [],
    };
    nuevos.set(h.id, item);
    onlyInPanel.push(item);
  }

  // Tarjetas por card_code.
  const duenoTarjeta = new Map(nube.cards.map((k) => [k.card_code, k.holder_id]));
  for (const k of snap.cards) {
    const m = titularDe.get(k.data.holder_id);
    const dueno = duenoTarjeta.get(k.data.card_code);
    if (dueno !== undefined) {
      if (dueno !== m) {
        conflicts.push({
          type: "card",
          id: k.id,
          holder_name: nombrePanel.get(k.data.holder_id) ?? "",
          card_code: k.data.card_code,
          reason: `La tarjeta ${k.data.card_code} ya es de otro titular (${nombreNube(dueno)}).`,
        });
      }
      continue;
    }
    const resumen: ImportCardSummary = { id: k.id, card_code: k.data.card_code, description: k.data.description };
    if (m !== undefined) onlyInPanel.push({ type: "card", holder_name: nombreNube(m), ...resumen });
    else nuevos.get(k.data.holder_id)!.cards.push(resumen);
  }

  // Controles. Cada botón se compara por rf_code: si la nube lo tiene en el mismo titular,
  // ya está; en otro titular, es conflicto; si no lo tiene, solo está en el panel.
  // El control "de la nube" es el del mismo UUID vivo en el mismo titular, o el del primer
  // botón que la nube ya tiene en ese titular: sus botones nuevos se le agregan (`button`)
  // si el número de botón está libre en ese control (si no, conflicto). Un control sin
  // control de la nube es nuevo (`control`, o anidado en su titular nuevo) con sus botones
  // libres; si todos sus botones chocan, solo deja conflictos.
  const duenoControl = new Map(nube.controls.map((c) => [c.id, c.holder_id]));
  const botonNube = new Map(nube.control_buttons.map((b) => [b.rf_code, b]));
  // Números de botón ocupados por control de la nube (también por los `button` ofrecidos).
  const ocupados = new Map<string, Set<number>>();
  for (const b of nube.control_buttons) {
    const usados = ocupados.get(b.control_id) ?? new Set<number>();
    usados.add(b.button);
    ocupados.set(b.control_id, usados);
  }
  const destinoDeBoton = new Map<string, string>();
  const botonesDe = agruparPor(snap.control_buttons, (b) => b.data.control_id);
  for (const c of snap.controls) {
    const m = titularDe.get(c.data.holder_id);
    const botones = botonesDe.get(c.id) ?? [];
    const nombre = nombrePanel.get(c.data.holder_id) ?? "";
    let destino: string | undefined;
    if (m !== undefined) {
      destino =
        duenoControl.get(c.id) === m
          ? c.id
          : botones
              .map((b) => botonNube.get(b.data.rf_code)?.control_id)
              .find((control) => control !== undefined && duenoControl.get(control) === m);
    }
    const libres: ImportButtonSummary[] = [];
    for (const b of botones) {
      const resumen: ImportButtonSummary = {
        id: b.id,
        button: b.data.button,
        rf_code: b.data.rf_code,
        output_id: b.data.output_id,
      };
      const enNube = botonNube.get(b.data.rf_code);
      if (enNube !== undefined) {
        const dueno = duenoControl.get(enNube.control_id);
        if (m === undefined || dueno !== m) {
          conflicts.push({
            type: "control_button",
            id: b.id,
            holder_name: nombre,
            rf_code: b.data.rf_code,
            reason: `El código RF ${b.data.rf_code} ya es de otro titular (${nombreNube(dueno)}).`,
          });
        }
        continue;
      }
      if (destino === undefined) {
        libres.push(resumen);
        continue;
      }
      const usados = ocupados.get(destino) ?? new Set<number>();
      if (usados.has(b.data.button)) {
        conflicts.push({
          type: "control_button",
          id: b.id,
          holder_name: nombre,
          rf_code: b.data.rf_code,
          reason: `El botón ${b.data.button} del control ya tiene otro código RF en la plataforma.`,
        });
        continue;
      }
      usados.add(b.data.button);
      ocupados.set(destino, usados);
      destinoDeBoton.set(b.id, destino);
      onlyInPanel.push({
        type: "button",
        holder_name: nombreNube(m),
        control_description: c.data.description,
        ...resumen,
      });
    }
    if (destino !== undefined || (botones.length > 0 && libres.length === 0)) continue;
    const resumen: ImportControlSummary = { id: c.id, description: c.data.description, buttons: libres };
    if (m !== undefined) onlyInPanel.push({ type: "control", holder_name: nombreNube(m), ...resumen });
    else nuevos.get(c.data.holder_id)!.controls.push(resumen);
  }

  // Permisos: cada permiso del panel cuyo UUID no es un perfil vivo de la instalación se
  // vuelve un perfil nuevo con el menor local_permission_id libre, en orden de
  // permission_id; los que no caben van a conflicts.
  const perfilesNube = new Set(nube.access_profiles.map((p) => p.id));
  const usados = new Set(nube.access_profiles.map((p) => p.local_permission_id));
  const libres = Array.from({ length: MAX_PROFILES }, (_, i) => i).filter((i) => !usados.has(i));
  const perfilesNuevos = new Map<string, number>();
  const permisosNuevos = snap.permissions
    .filter((p) => !perfilesNube.has(p.id))
    .sort((a, b) => a.data.permission_id - b.data.permission_id);
  permisosNuevos.forEach((p, i) => {
    if (i < libres.length) {
      perfilesNuevos.set(p.id, libres[i]);
    } else {
      conflicts.push({
        type: "permission",
        id: p.id,
        permission_id: p.data.permission_id,
        name: p.data.name,
        reason: MAXIMO_PERFILES,
      });
    }
  });

  return { diff: { onlyInPanel, conflicts }, titularDe, perfilesNuevos, destinoDeBoton };
}

/**
 * Lo que solo tiene el panel (`onlyInPanel`) y lo que choca con la nube (`conflicts`).
 * Criterios de coincidencia:
 * - titular: el mismo UUID vivo en la instalación, o el mismo `kind` y `name` sin
 *   distinguir mayúsculas;
 * - tarjeta por `card_code`, botón por `rf_code` y PIN por `pin_lookup`.
 * Lo que la nube ya tiene con el mismo dueño (el titular emparejado) no aparece. Un RF
 * que la nube no tiene, en un control que la nube ya tiene en ese titular, es un
 * `button` para ese control. Son conflictos: una tarjeta, un código RF o un PIN de otro
 * titular; un PIN distinto del que ya tiene el titular en la nube; un botón cuyo número
 * ya ocupa otro RF en el control de la nube; y los permisos que pasan de `MAX_PROFILES`
 * perfiles. Los permisos que caben, sus asignaciones y las salidas no se listan: se
 * importan siempre.
 */
export function computeImportDiff(cloud: CloudState, snapshot: StoredSnapshot): ImportDiff {
  return analizar(cloud, snapshot).diff;
}

// ---------------------------------------------------------------------------
// Planes de importación (puros)
// ---------------------------------------------------------------------------

const planTarjeta = (k: ContractRow<"cards">, holderId: string) => ({
  id: k.id,
  card_code: k.data.card_code,
  holder_id: holderId,
  description: k.data.description,
});

const planBoton = (b: ContractRow<"control_buttons">) => ({
  id: b.id,
  control_id: b.data.control_id,
  button: b.data.button,
  rf_code: b.data.rf_code,
  output_index: b.data.output_id,
});

function planPerfil(p: ContractRow<"permissions">, localPermissionId: number): ImportPlan["access_profiles"][number] {
  const d = p.data;
  return {
    id: p.id,
    name: d.name,
    local_permission_id: localPermissionId,
    output_mask: d.output_mask,
    card_reader_mask: d.card_reader_mask,
    pin_reader_mask: d.pin_reader_mask,
    allow_rf: d.allow_rf,
    weekday_mask: d.weekday_mask,
    start_minute: d.start_minute,
    end_minute: d.end_minute,
  };
}

const planSalida = ({ id, data: { output_id, ...resto } }: ContractRow<"outputs">) => ({
  id,
  output_index: output_id,
  ...resto,
});

/** Importación directa (instalación vacía): todo, con `local_permission_id = permission_id`. */
function directPlan(snap: StoredSnapshot): ImportPlan {
  const perfilDe = new Map(snap.permissions.map((p) => [p.data.permission_id, p.id]));
  return {
    holders: snap.holders.map((h) => ({ id: h.id, ...h.data })),
    holder_pins: [],
    cards: snap.cards.map((k) => planTarjeta(k, k.data.holder_id)),
    controls: snap.controls.map((c) => ({ id: c.id, ...c.data })),
    control_buttons: snap.control_buttons.map(planBoton),
    access_profiles: snap.permissions.map((p) => planPerfil(p, p.data.permission_id)),
    holder_profiles: snap.holder_permissions.map((a) => ({
      id: a.id,
      holder_id: a.data.holder_id,
      profile_id: perfilDe.get(a.data.permission_id)!,
    })),
    outputs: snap.outputs.map(planSalida),
  };
}

/**
 * Plan de una importación revisada: solo los IDs seleccionados que están en
 * `onlyInPanel` (un titular nuevo con todo lo suyo que se puede importar; una tarjeta,
 * control, botón o PIN de un titular de la nube, que se reutiliza). Los permisos que
 * caben y no son un perfil vivo (mismo UUID) se vuelven perfiles nuevos con regla solo en
 * este panel. Las asignaciones del panel son la unión: cada titular que queda en la nube
 * (nuevo seleccionado o emparejado) recibe las que tenía en el panel y la nube no tiene,
 * con el perfil nuevo o el perfil vivo con el mismo UUID. Las salidas del panel se
 * importan siempre.
 */
function confirmPlan(nube: CloudState, snap: StoredSnapshot, seleccion: readonly string[]) {
  const { diff, titularDe, perfilesNuevos, destinoDeBoton } = analizar(nube, snap);
  const items = agruparPor(diff.onlyInPanel, (i) => i.id);
  const imported = seleccion.filter((id) => items.has(id));
  const ignored = seleccion.filter((id) => !items.has(id));

  const titulares = new Map(snap.holders.map((h) => [h.id, h]));
  const tarjetas = new Map(snap.cards.map((k) => [k.id, k]));
  const controles = new Map(snap.controls.map((c) => [c.id, c]));
  const botones = new Map(snap.control_buttons.map((b) => [b.id, b]));
  const plan: ImportPlan = {
    holders: [],
    holder_pins: [],
    cards: [],
    controls: [],
    control_buttons: [],
    access_profiles: [],
    holder_profiles: [],
    outputs: snap.outputs.map(planSalida),
  };

  // Un control nuevo cuyo UUID es un control vivo de la instalación (de otro titular)
  // recibe un UUID nuevo aquí: así toda referencia del plan a un control vivo apunta a
  // un control de la nube y la reasignación de ids de import_rows no es ambigua.
  const controlesNube = new Set(nube.controls.map((c) => c.id));
  const agregarControl = (resumen: ImportControlSummary, holderId: string) => {
    const id = controlesNube.has(resumen.id) ? randomUUID() : resumen.id;
    plan.controls.push({ id, holder_id: holderId, description: controles.get(resumen.id)!.data.description });
    for (const b of resumen.buttons) plan.control_buttons.push({ ...planBoton(botones.get(b.id)!), control_id: id });
  };
  const titularesNuevos = new Set<string>();
  for (const item of imported.flatMap((id) => items.get(id)!)) {
    switch (item.type) {
      case "holder": {
        const h = titulares.get(item.id)!;
        titularesNuevos.add(h.id);
        plan.holders.push({ id: h.id, ...h.data, ...(item.has_pin ? {} : { pin_ciphertext: null, pin_lookup: null }) });
        for (const k of item.cards) plan.cards.push(planTarjeta(tarjetas.get(k.id)!, h.id));
        for (const c of item.controls) agregarControl(c, h.id);
        break;
      }
      case "card": {
        const k = tarjetas.get(item.id)!;
        plan.cards.push(planTarjeta(k, titularDe.get(k.data.holder_id)!));
        break;
      }
      case "control":
        agregarControl(item, titularDe.get(controles.get(item.id)!.data.holder_id)!);
        break;
      case "button":
        plan.control_buttons.push({ ...planBoton(botones.get(item.id)!), control_id: destinoDeBoton.get(item.id)! });
        break;
      case "pin": {
        const h = titulares.get(item.id)!;
        plan.holder_pins.push({
          holder_id: titularDe.get(h.id)!,
          pin_ciphertext: h.data.pin_ciphertext!,
          pin_lookup: h.data.pin_lookup!,
        });
        break;
      }
    }
  }

  // Perfil de cada permission_id del panel: el perfil vivo con el mismo UUID, o el perfil
  // nuevo que se crea (los que no caben en MAX_PROFILES no tienen y ya son conflicto).
  const perfilesNube = new Set(nube.access_profiles.map((p) => p.id));
  const perfilDe = new Map<number, string>();
  for (const p of snap.permissions) {
    const local = perfilesNuevos.get(p.id);
    if (local !== undefined) plan.access_profiles.push(planPerfil(p, local));
    if (local !== undefined || perfilesNube.has(p.id)) perfilDe.set(p.data.permission_id, p.id);
  }
  // Asignaciones: la unión. Cada titular del panel que queda en la nube (nuevo
  // seleccionado o emparejado) recibe las que tenía en el panel y la nube no tiene
  // (nadie pierde acceso en este panel al adoptar los datos de la nube).
  const asignadas = new Set(nube.holder_profiles.map((a) => `${a.holder_id} ${a.profile_id}`));
  for (const a of snap.holder_permissions) {
    const perfil = perfilDe.get(a.data.permission_id);
    const titular = titularesNuevos.has(a.data.holder_id) ? a.data.holder_id : titularDe.get(a.data.holder_id);
    if (perfil === undefined || titular === undefined) continue;
    // También evita dos asignaciones iguales si dos titulares del panel se emparejan
    // con el mismo de la nube.
    const clave = `${titular} ${perfil}`;
    if (asignadas.has(clave)) continue;
    asignadas.add(clave);
    plan.holder_profiles.push({ id: a.id, holder_id: titular, profile_id: perfil });
  }

  return { plan, imported, ignored };
}

// ---------------------------------------------------------------------------
// Base de datos
// ---------------------------------------------------------------------------

/** Filas por consulta al leer la nube (no rebasa `max_rows` de PostgREST). */
const PAGINA_LECTURA = 1000;

/** Filas vivas de una tabla de la instalación, por páginas con llave `id`. */
async function leerVivas<T extends { id: string }>(
  admin: SupabaseClient,
  tabla: string,
  installationId: string,
  columnas: string,
): Promise<T[]> {
  const filas: T[] = [];
  let ultimoId: string | null = null;
  for (;;) {
    let consulta = admin.from(tabla).select(columnas).eq("installation_id", installationId).is("deleted_at", null);
    if (ultimoId !== null) consulta = consulta.gt("id", ultimoId);
    const { data, error } = await consulta.order("id").limit(PAGINA_LECTURA).overrideTypes<T[], { merge: false }>();
    if (error) throw error;
    if (data.length === 0) return filas;
    filas.push(...data);
    ultimoId = data[data.length - 1].id;
  }
}

async function loadCloudState(admin: SupabaseClient, installationId: string): Promise<CloudState> {
  const [holders, cards, controls, control_buttons, access_profiles, holder_profiles] = await Promise.all([
    leerVivas<CloudState["holders"][number]>(admin, "holders", installationId, "id, kind, name, pin_lookup"),
    leerVivas<CloudState["cards"][number]>(admin, "cards", installationId, "id, card_code, holder_id"),
    leerVivas<CloudState["controls"][number]>(admin, "controls", installationId, "id, holder_id"),
    leerVivas<CloudState["control_buttons"][number]>(
      admin,
      "control_buttons",
      installationId,
      "id, control_id, button, rf_code",
    ),
    leerVivas<CloudState["access_profiles"][number]>(admin, "access_profiles", installationId, "id, local_permission_id"),
    leerVivas<CloudState["holder_profiles"][number]>(admin, "holder_profiles", installationId, "id, holder_id, profile_id"),
  ]);
  return { holders, cards, controls, control_buttons, access_profiles, holder_profiles };
}

/** Llama una función de importación de 0004 (devuelven un estado en texto). */
async function llamar(admin: SupabaseClient, funcion: string, args: Record<string, unknown>): Promise<string> {
  return retryOnDeadlock(async () => {
    const { data, error } = await admin.rpc(funcion, args);
    if (error) throw error;
    return data as string;
  });
}

/** 409 de `POST /import-snapshot` cuando el panel ya no está en `staging`. */
export function notStaging(): DeviceApiError {
  return new DeviceApiError(
    409,
    "not_staging",
    "El panel no está en preparación: su base solo se importa una vez, al vincularlo.",
  );
}

/**
 * Importa la base de un panel en `staging` (ya validada con `snapshotProblem`). Con la
 * instalación vacía la escribe entera y devuelve `active`; si tiene datos, guarda el
 * snapshot (PIN cifrado) y el diff en `panel_imports` y devuelve `awaiting_review`.
 * Si el panel salió de `staging` mientras tanto lanza 409 `not_staging`.
 */
export async function stageSnapshot(panel: Panel, tables: SnapshotTables): Promise<"active" | "awaiting_review"> {
  const admin = createAdminSupabase();
  const snapshot = protectSnapshot(panel.installation_id, tables);

  const directa = await llamar(admin, "import_panel_snapshot", { p_panel_id: panel.id, p_plan: directPlan(snapshot) });
  if (directa === "imported") return "active";
  if (directa === "not_staging") throw notStaging();

  const diff = computeImportDiff(await loadCloudState(admin, panel.installation_id), snapshot);
  const guardada = await llamar(admin, "stage_panel_import", {
    p_panel_id: panel.id,
    p_snapshot: snapshot,
    p_diff: diff,
  });
  if (guardada !== "awaiting_review") throw notStaging();
  return "awaiting_review";
}

interface PanelEnRevision {
  id: string;
  tenant_id: string;
  installation_id: string;
  status: string;
}

/** Panel visible para el usuario (RLS) en un tenant donde tiene al menos `rol`; si no, 404/403. */
async function panelDelUsuario(supabase: SupabaseClient, panelId: string, rol: TenantRole): Promise<PanelEnRevision> {
  const { supabase: cliente } = await requireUser(supabase);
  const noExiste = new HttpError(404, "El panel no existe.");
  if (!z.guid().safeParse(panelId).success) throw noExiste;
  const { data: panel, error } = await cliente
    .from("panels")
    .select("id, tenant_id, installation_id, status")
    .eq("id", panelId)
    .maybeSingle<PanelEnRevision>();
  if (error) throw error;
  if (!panel) throw noExiste;
  await requireTenantRole(panel.tenant_id, rol, cliente);
  return panel;
}

/** Una columna de la importación pendiente de un panel (`null` si no hay). */
async function leerImportacion(admin: SupabaseClient, panelId: string, columna: "snapshot" | "diff"): Promise<unknown> {
  const { data, error } = await admin
    .from("panel_imports")
    .select(columna)
    .eq("panel_id", panelId)
    .maybeSingle<Record<string, unknown>>();
  if (error) throw error;
  return data?.[columna] ?? null;
}

/**
 * Diff de la importación pendiente de un panel, para la pantalla de revisión (cualquier
 * miembro del tenant). Sin PIN. 404 si el panel no es visible o no está en
 * `awaiting_review`.
 */
export async function readImportDiffAs(supabase: SupabaseClient, panelId: string): Promise<ImportDiff> {
  const panel = await panelDelUsuario(supabase, panelId, "tecnico");
  const sinImportacion = new HttpError(404, SIN_IMPORTACION);
  if (panel.status !== "awaiting_review") throw sinImportacion;
  const diff = (await leerImportacion(createAdminSupabase(), panel.id, "diff")) as ImportDiff | null;
  if (!diff) throw sinImportacion;
  return diff;
}

/**
 * Confirma la importación de un panel en `awaiting_review` (solo `admin`): importa los
 * `selectedIds` que siguen en `onlyInPanel` (el diff se recalcula contra la nube de
 * ahora; los demás se devuelven en `ignored`), los perfiles nuevos y las salidas, como
 * cambios del panel; deja el panel `active` y borra su `panel_imports`, todo en una
 * transacción. Si la instalación cambió entre la lectura y la escritura, rearma el plan
 * (hasta `INTENTOS_CONFIRMAR` veces). Un panel no visible: 404; sin importación
 * pendiente: 409.
 */
export async function confirmImportAs(
  supabase: SupabaseClient,
  panelId: string,
  selectedIds: readonly string[],
): Promise<ConfirmImportResult> {
  const panel = await panelDelUsuario(supabase, panelId, "admin");
  const sinImportacion = new HttpError(409, SIN_IMPORTACION);
  if (panel.status !== "awaiting_review") throw sinImportacion;
  const admin = createAdminSupabase();
  const snapshot = (await leerImportacion(admin, panel.id, "snapshot")) as StoredSnapshot | null;
  if (!snapshot) throw sinImportacion;
  const seleccion = [...new Set(selectedIds)];

  for (let intento = 0; intento < INTENTOS_CONFIRMAR; intento++) {
    // Con la misma revisión al escribir, nada cambió desde estas lecturas.
    const revision = await readInstallationRevision(admin, panel.installation_id);
    const { plan, imported, ignored } = confirmPlan(
      await loadCloudState(admin, panel.installation_id),
      snapshot,
      seleccion,
    );
    const resultado = await llamar(admin, "confirm_panel_import", {
      p_panel_id: panel.id,
      p_plan: plan,
      p_expected_revision: revision,
    });
    if (resultado === "imported") return { imported, ignored };
    if (resultado === "not_awaiting") throw sinImportacion;
  }
  throw new HttpError(409, IMPORT_STALE_MESSAGE);
}
