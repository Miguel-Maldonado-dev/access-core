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
export async function listCardsAs(supabase: SupabaseClient, tenantId: string, installationId: string): Promise<CardRow[]> {
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

/** Crea una tarjeta. 409 con el titular que ya la tiene si el código está registrado. */
export async function createCardAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  entrada: CardInput,
): Promise<{ id: string }> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
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
    .insert({ installation_id: installationId, card_code: cod.data, holder_id: holderId, description: desc })
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
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  cardId: string,
  entrada: Pick<CardInput, "holder_id" | "description">,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "La tarjeta no existe.");
  if (!esUuid(cardId)) throw noExiste;
  const holderId = await requireHolder(cliente, installationId, entrada?.holder_id);
  const { data, error } = await cliente
    .from("cards")
    .update({ holder_id: holderId, description: descripcion.parse(entrada.description) })
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
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  cardId: string,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "La tarjeta no existe.");
  if (!esUuid(cardId)) throw noExiste;
  const { data, error } = await cliente
    .from("cards")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", cardId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw noExiste;
}
