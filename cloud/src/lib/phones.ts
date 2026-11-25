import "server-only";
import { autoria, type DataClient } from "@/lib/auth/guards";
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
import { HttpError } from "@/lib/errors";
import { PHONE_MESSAGE, cleanPhone } from "@/lib/phone-view";

/** Teléfonos de los titulares de una instalación como el usuario de la sesión (RLS). 10 dígitos. */

export interface PhoneRow {
  id: string;
  holder_id: string;
  holder_name: string;
  number: string;
  description: string;
}

export interface PhoneInput {
  number: string;
  holder_id: string;
  description: string;
}

export { PHONE_MESSAGE };
export const PHONE_TAKEN_MESSAGE = "El número ya está registrado";

/** Número capturado por una persona: sin espacios ni guiones, exactamente 10 dígitos (como el panel). */
export function parsePhoneInput(raw: string): string {
  const limpio = cleanPhone(raw);
  if (limpio === null) throw new HttpError(400, PHONE_MESSAGE);
  return limpio;
}

function parseDescription(valor: unknown): string {
  if (valor === undefined || valor === null) return "";
  if (typeof valor !== "string") throw new HttpError(400, "La descripción no es válida.");
  return valor.trim();
}

const COLUMNAS = "id, number, holder_id, description";

/** Teléfonos vivos con el nombre de su titular, por número (cualquier miembro). */
export async function listPhonesAs(supabase: DataClient, tenantId: string, installationId: string): Promise<PhoneRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const [telefonos, nombres] = await Promise.all([
    fetchAll<Omit<PhoneRow, "holder_name">>((desde, hasta) =>
      cliente
        .from("phones")
        .select(COLUMNAS)
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("number")
        .order("id")
        .range(desde, hasta),
    ),
    holderNames(cliente, installationId),
  ]);
  return telefonos.map((t) => ({ ...t, holder_name: nombres.get(t.holder_id) ?? "" }));
}

/** Un teléfono vivo por id; 404 si no existe o es de otra instalación. */
export async function getPhoneAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  phoneId: string,
): Promise<PhoneRow> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "El teléfono no existe.");
  if (!esUuid(phoneId)) throw noExiste;
  const { data, error } = await cliente
    .from("phones")
    .select(COLUMNAS)
    .eq("id", phoneId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle<Omit<PhoneRow, "holder_name">>();
  if (error) throw error;
  if (!data) throw noExiste;
  const nombres = await holderNames(cliente, installationId, [data.holder_id]);
  return { ...data, holder_name: nombres.get(data.holder_id) ?? "" };
}

/** Crea un teléfono. 409 "El número ya está registrado" si otro teléfono vivo lo tiene. */
export async function createPhoneAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  entrada: PhoneInput,
): Promise<{ id: string }> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const numero = parsePhoneInput(entrada?.number);
  const holderId = await requireHolder(cliente, installationId, entrada.holder_id);
  const descripcion = parseDescription(entrada.description);

  const { data: dueno, error: errorDueno } = await cliente
    .from("phones")
    .select("id")
    .eq("installation_id", installationId)
    .eq("number", numero)
    .is("deleted_at", null)
    .maybeSingle<{ id: string }>();
  if (errorDueno) throw errorDueno;
  if (dueno) throw new HttpError(409, PHONE_TAKEN_MESSAGE);

  const { data, error } = await cliente
    .from("phones")
    .insert({ installation_id: installationId, number: numero, holder_id: holderId, description: descripcion, ...autoria(acceso) })
    .select("id")
    .single<{ id: string }>();
  if (error) {
    // Carrera entre la comprobación y la escritura.
    if (isUniqueViolation(error, "phones_number_live_key")) throw new HttpError(409, PHONE_TAKEN_MESSAGE);
    if (isMissingParent(error)) throw new HttpError(409, HOLDER_GONE);
    throw error;
  }
  return data;
}

/** Cambia número, titular y descripción. */
export async function updatePhoneAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  phoneId: string,
  entrada: PhoneInput,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const noExiste = new HttpError(404, "El teléfono no existe.");
  if (!esUuid(phoneId)) throw noExiste;
  const numero = parsePhoneInput(entrada?.number);
  const holderId = await requireHolder(cliente, installationId, entrada.holder_id);
  const { data, error } = await cliente
    .from("phones")
    .update({ number: numero, holder_id: holderId, description: parseDescription(entrada.description), ...autoria(acceso) })
    .eq("id", phoneId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    if (isUniqueViolation(error, "phones_number_live_key")) throw new HttpError(409, PHONE_TAKEN_MESSAGE);
    if (isMissingParent(error)) throw new HttpError(409, HOLDER_GONE);
    throw error;
  }
  if (data.length === 0) throw noExiste;
}

/** Borrado lógico del teléfono (libera su número). */
export async function deletePhoneAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  phoneId: string,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const noExiste = new HttpError(404, "El teléfono no existe.");
  if (!esUuid(phoneId)) throw noExiste;
  const { data, error } = await cliente
    .from("phones")
    .update({ deleted_at: new Date().toISOString(), ...autoria(acceso) })
    .eq("id", phoneId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw noExiste;
}
