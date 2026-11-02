import "server-only";
import { z } from "zod";
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
import { CODE_MESSAGE, MAX_CODE, cardTakenMessage } from "@/lib/access-view";
import { HttpError } from "@/lib/errors";

/** Tarjetas de una instalación como el usuario de la sesión (RLS). Códigos en decimal. */

export interface CardRow {
  id: string;
  card_code: number;
  holder_id: string;
  holder_name: string;
  description: string;
}

export interface CardInput {
  card_code: number;
  holder_id: string;
  description: string;
}

const codigo = z.number({ error: CODE_MESSAGE }).int(CODE_MESSAGE).min(0, CODE_MESSAGE).max(MAX_CODE, CODE_MESSAGE);
const descripcion = z.string().trim().default("");

function aviso(r: { success: false; error: z.ZodError }): never {
  throw new HttpError(400, r.error.issues[0]?.message ?? "Datos inválidos.");
}

/** Tarjetas vivas con el nombre de su titular, por código (cualquier miembro). */
export async function listCardsAs(supabase: DataClient, tenantId: string, installationId: string): Promise<CardRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const [tarjetas, nombres] = await Promise.all([
    fetchAll<Omit<CardRow, "holder_name">>((desde, hasta) =>
      cliente
        .from("cards")
        .select("id, card_code, holder_id, description")
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("card_code")
        .order("id")
        .range(desde, hasta),
    ),
    holderNames(cliente, installationId),
  ]);
  return tarjetas.map((c) => ({ ...c, holder_name: nombres.get(c.holder_id) ?? "" }));
}

/** Una tarjeta viva por id, con el nombre de su titular; 404 si no existe o es de otra instalación. */
export async function getCardAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  cardId: string,
): Promise<CardRow> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "La tarjeta no existe.");
  if (!esUuid(cardId)) throw noExiste;
  const { data, error } = await cliente
    .from("cards")
    .select("id, card_code, holder_id, description")
    .eq("id", cardId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle<Omit<CardRow, "holder_name">>();
  if (error) throw error;
  if (!data) throw noExiste;
  const nombres = await holderNames(cliente, installationId, [data.holder_id]);
  return { ...data, holder_name: nombres.get(data.holder_id) ?? "" };
}

/** Crea una tarjeta. 409 con el titular que ya la tiene si el código está registrado. */
export async function createCardAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  entrada: CardInput,
): Promise<{ id: string }> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const cod = codigo.safeParse(entrada?.card_code);
  if (!cod.success) aviso(cod);
  const holderId = await requireHolder(cliente, installationId, entrada.holder_id);
  const desc = descripcion.parse(entrada.description);

  const { data: dueno, error: errorDueno } = await cliente
    .from("cards")
    .select("holder_id")
    .eq("installation_id", installationId)
    .eq("card_code", cod.data)
    .is("deleted_at", null)
    .maybeSingle<{ holder_id: string }>();
  if (errorDueno) throw errorDueno;
  if (dueno) {
    const nombre = (await holderNames(cliente, installationId, [dueno.holder_id])).get(dueno.holder_id) ?? "otro titular";
    throw new HttpError(409, cardTakenMessage(cod.data, nombre));
  }

  const { data, error } = await cliente
    .from("cards")
    .insert({ installation_id: installationId, card_code: cod.data, holder_id: holderId, description: desc, ...autoria(acceso) })
    .select("id")
    .single<{ id: string }>();
  if (error) {
    // Carrera entre la comprobación y la escritura.
    if (isUniqueViolation(error, "cards_card_code_live_key")) {
      throw new HttpError(409, `La tarjeta ${cod.data} ya está registrada.`);
    }
    if (isMissingParent(error)) throw new HttpError(409, HOLDER_GONE);
    throw error;
  }
  return data;
}

/** Cambia titular y descripción (el código no se edita, como en el panel local). */
export async function updateCardAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  cardId: string,
  entrada: Pick<CardInput, "holder_id" | "description">,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const noExiste = new HttpError(404, "La tarjeta no existe.");
  if (!esUuid(cardId)) throw noExiste;
  const holderId = await requireHolder(cliente, installationId, entrada?.holder_id);
  const { data, error } = await cliente
    .from("cards")
    .update({ holder_id: holderId, description: descripcion.parse(entrada.description), ...autoria(acceso) })
    .eq("id", cardId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    if (isMissingParent(error)) throw new HttpError(409, HOLDER_GONE);
    throw error;
  }
  if (data.length === 0) throw noExiste;
}

/** Borrado lógico de la tarjeta (libera su código). */
export async function deleteCardAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  cardId: string,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const noExiste = new HttpError(404, "La tarjeta no existe.");
  if (!esUuid(cardId)) throw noExiste;
  const { data, error } = await cliente
    .from("cards")
    .update({ deleted_at: new Date().toISOString(), ...autoria(acceso) })
    .eq("id", cardId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw noExiste;
}
