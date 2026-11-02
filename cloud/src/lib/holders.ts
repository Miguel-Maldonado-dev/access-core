import "server-only";
import { z } from "zod";
import { autoria, type DataClient } from "@/lib/auth/guards";
import {
  esUuid,
  fetchAll,
  isMissingParent,
  isUniqueViolation,
  HOLDER_GONE,
  requireInstallationAccess,
} from "@/lib/access-data";
import { PIN_MESSAGE, PIN_TAKEN_MESSAGE, type HolderKind } from "@/lib/access-view";
import { decryptPin, encryptPin, pinLookup } from "@/lib/crypto";
import { HttpError } from "@/lib/errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Titulares de una instalación como el usuario de la sesión (RLS). El PIN se cifra aquí
 * (`encryptPin`) y su unicidad se comprueba con `pinLookup`; `authenticated` no puede leer
 * esas columnas, así que su comprobación y la lectura del PIN actual (solo `admin`) usan la
 * llave secreta, siempre después de la guarda.
 */

export interface HolderRow {
  id: string;
  kind: HolderKind;
  name: string;
  department: string;
  address: string;
  notes: string;
  has_pin: boolean;
  card_count: number;
  control_count: number;
}

/** Qué hacer con el PIN al guardar: conservarlo, poner uno nuevo o quitarlo. */
export type PinChange = { mode: "keep" } | { mode: "set"; pin: string } | { mode: "clear" };

export interface HolderInput {
  kind: HolderKind;
  name: string;
  department: string;
  address: string;
  notes: string;
  pin: PinChange;
}

const COLUMNAS = "id, kind, name, department, address, notes, has_pin";

const esquema = z.object({
  kind: z.enum(["persona", "domicilio"], { error: "El tipo debe ser persona o domicilio." }),
  name: z.string({ error: "El nombre es obligatorio." }).trim().min(1, "El nombre es obligatorio."),
  department: z.string().trim().default(""),
  address: z.string().trim().default(""),
  notes: z.string().trim().default(""),
  pin: z.discriminatedUnion(
    "mode",
    [
      z.object({ mode: z.literal("keep") }),
      z.object({ mode: z.literal("clear") }),
      z.object({ mode: z.literal("set"), pin: z.string().trim().regex(/^\d{4,6}$/, PIN_MESSAGE) }),
    ],
    { error: PIN_MESSAGE },
  ),
});

function parseInput(entrada: unknown): HolderInput {
  const r = esquema.safeParse(entrada);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Datos inválidos.");
  return r.data;
}

/** Titulares vivos con sus conteos de tarjetas y controles, por nombre (cualquier miembro). */
export async function listHoldersAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
): Promise<HolderRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const hijos = (tabla: "cards" | "controls") =>
    fetchAll<{ holder_id: string }>((desde, hasta) =>
      cliente
        .from(tabla)
        .select("holder_id")
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("id")
        .range(desde, hasta),
    );
  const [titulares, tarjetas, controles] = await Promise.all([
    fetchAll<Omit<HolderRow, "card_count" | "control_count">>((desde, hasta) =>
      cliente
        .from("holders")
        .select(COLUMNAS)
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("name")
        .order("id")
        .range(desde, hasta),
    ),
    hijos("cards"),
    hijos("controls"),
  ]);

  const contar = (filas: { holder_id: string }[]) => {
    const m = new Map<string, number>();
    for (const f of filas) m.set(f.holder_id, (m.get(f.holder_id) ?? 0) + 1);
    return m;
  };
  const nTarjetas = contar(tarjetas);
  const nControles = contar(controles);
  return titulares.map((h) => ({
    ...h,
    card_count: nTarjetas.get(h.id) ?? 0,
    control_count: nControles.get(h.id) ?? 0,
  }));
}

/** Un titular vivo con sus conteos de tarjetas y controles (cualquier miembro). 404 si no existe. */
export async function getHolderAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  holderId: string,
): Promise<HolderRow> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "El titular no existe.");
  if (!esUuid(holderId)) throw noExiste;
  const conteo = async (tabla: "cards" | "controls") => {
    const { count, error } = await cliente
      .from(tabla)
      .select("id", { count: "exact", head: true })
      .eq("installation_id", installationId)
      .eq("holder_id", holderId)
      .is("deleted_at", null);
    if (error) throw error;
    return count ?? 0;
  };
  const [{ data, error }, tarjetas, controles] = await Promise.all([
    cliente
      .from("holders")
      .select(COLUMNAS)
      .eq("id", holderId)
      .eq("installation_id", installationId)
      .is("deleted_at", null)
      .maybeSingle<Omit<HolderRow, "card_count" | "control_count">>(),
    conteo("cards"),
    conteo("controls"),
  ]);
  if (error) throw error;
  if (!data) throw noExiste;
  return { ...data, card_count: tarjetas, control_count: controles };
}

/** Columnas de PIN a escribir y comprobación de unicidad (solo si cambia el PIN). */
async function pinColumns(
  installationId: string,
  holderId: string | null,
  cambio: PinChange,
): Promise<Record<string, string | null>> {
  if (cambio.mode === "keep") return {};
  if (cambio.mode === "clear") return { pin_ciphertext: null, pin_lookup: null };
  const lookup = pinLookup(installationId, cambio.pin);
  let consulta = createAdminSupabase()
    .from("holders")
    .select("id")
    .eq("installation_id", installationId)
    .eq("pin_lookup", lookup)
    .is("deleted_at", null);
  if (holderId) consulta = consulta.neq("id", holderId);
  const { data, error } = await consulta.limit(1);
  if (error) throw error;
  if (data.length > 0) throw new HttpError(409, PIN_TAKEN_MESSAGE);
  return { pin_ciphertext: encryptPin(cambio.pin), pin_lookup: lookup };
}

function traducir(error: { code?: string; message?: string }): never {
  if (isUniqueViolation(error, "holders_pin_lookup_live_key")) throw new HttpError(409, PIN_TAKEN_MESSAGE);
  if (isMissingParent(error)) throw new HttpError(409, HOLDER_GONE);
  throw error;
}

/** Crea un titular (cualquier miembro). */
export async function createHolderAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  entrada: HolderInput,
): Promise<{ id: string }> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const { pin, ...datos } = parseInput(entrada);
  const columnas = await pinColumns(installationId, null, pin);
  const { data, error } = await cliente
    .from("holders")
    .insert({ installation_id: installationId, ...datos, ...columnas, ...autoria(acceso) })
    .select("id")
    .single<{ id: string }>();
  if (error) traducir(error);
  return data;
}

/** Edita un titular (cualquier miembro). `pin: keep` no toca el PIN. 404 si no existe. */
export async function updateHolderAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  holderId: string,
  entrada: HolderInput,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const noExiste = new HttpError(404, "El titular no existe.");
  if (!esUuid(holderId)) throw noExiste;
  const { pin, ...datos } = parseInput(entrada);
  const columnas = await pinColumns(installationId, holderId, pin);
  const { data, error } = await cliente
    .from("holders")
    .update({ ...datos, ...columnas, ...autoria(acceso) })
    .eq("id", holderId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) traducir(error);
  if (data.length === 0) throw noExiste;
}

/**
 * Pone o quita solo el PIN de un titular (no reescribe los demás campos, así no pisa una
 * edición simultánea). Firma con `autoria`. 404 si no existe; 409 si el PIN ya está en uso.
 */
export async function setHolderPinAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  holderId: string,
  cambio: { mode: "set"; pin: string } | { mode: "clear" },
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "El titular no existe.");
  if (!esUuid(holderId)) throw noExiste;
  const validado = esquema.shape.pin.safeParse(cambio);
  if (!validado.success) throw new HttpError(400, validado.error.issues[0]?.message ?? PIN_MESSAGE);
  const columnas = await pinColumns(installationId, holderId, validado.data);
  const { data, error } = await acceso.supabase
    .from("holders")
    .update({ ...columnas, ...autoria(acceso) })
    .eq("id", holderId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) traducir(error);
  if (data.length === 0) throw noExiste;
}

/** Borrado lógico del titular; el trigger lo extiende a sus tarjetas, controles y botones. */
export async function deleteHolderAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  holderId: string,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const noExiste = new HttpError(404, "El titular no existe.");
  if (!esUuid(holderId)) throw noExiste;
  const { data, error } = await cliente
    .from("holders")
    .update({ deleted_at: new Date().toISOString(), ...autoria(acceso) })
    .eq("id", holderId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw noExiste;
}

/**
 * PIN actual de un titular, o `null` si no tiene. Solo `admin` (403 al técnico): el rol se
 * comprueba ANTES de usar la llave secreta para leer y descifrar.
 */
export async function getHolderPinAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  holderId: string,
): Promise<string | null> {
  await requireInstallationAccess(supabase, tenantId, installationId, "admin");
  const noExiste = new HttpError(404, "El titular no existe.");
  if (!esUuid(holderId)) throw noExiste;
  const { data, error } = await createAdminSupabase()
    .from("holders")
    .select("pin_ciphertext")
    .eq("id", holderId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle<{ pin_ciphertext: string | null }>();
  if (error) throw error;
  if (!data) throw noExiste;
  return data.pin_ciphertext === null ? null : decryptPin(data.pin_ciphertext);
}
