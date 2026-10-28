import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { esUuid, fetchAll, requireInstallationAccess } from "@/lib/access-data";
import { HttpError } from "@/lib/errors";
import { DURATION_MESSAGE, NAME_MAX, OUTPUT_MAX_MS } from "@/lib/profile-view";

/**
 * Salidas (4 por panel) como el usuario de la sesión (RLS; admin y técnico). Las salidas
 * nacen al importar un panel: aquí solo se editan alias, duración, lectores y si está
 * habilitada (nunca se crean ni se borran).
 */

export interface OutputInput {
  alias: string;
  duration_ms: number;
  reader_mask: number;
  enabled: boolean;
}

export interface OutputRow extends OutputInput {
  id: string;
  panel_id: string;
  output_index: number;
}

const COLUMNAS = "id, panel_id, output_index, alias, duration_ms, reader_mask, enabled";
const NO_EXISTE = "La salida no existe.";

const esquema = z.strictObject({
  alias: z
    .string({ error: "El alias no es válido." })
    .trim()
    .max(NAME_MAX, `El alias admite hasta ${NAME_MAX} caracteres.`)
    .refine((s) => !s.includes("\u0000"), "El alias contiene caracteres no válidos."),
  duration_ms: z.int({ error: DURATION_MESSAGE }).min(0, DURATION_MESSAGE).max(OUTPUT_MAX_MS, DURATION_MESSAGE),
  reader_mask: z.int({ error: "Los lectores no son válidos." }).min(0).max(15),
  enabled: z.boolean({ error: "Datos inválidos." }),
});

/** Salidas vivas de la instalación, por panel y número (cualquier miembro). */
export async function listOutputsAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
): Promise<OutputRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  return fetchAll<OutputRow>((desde, hasta) =>
    cliente
      .from("outputs")
      .select(COLUMNAS)
      .eq("installation_id", installationId)
      .is("deleted_at", null)
      .order("panel_id")
      .order("output_index")
      .order("id")
      .range(desde, hasta),
  );
}

/** Edita una salida; si nada cambió no escribe (cada escritura sube la revisión y avisa al panel). */
export async function updateOutputAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  outputId: string,
  entrada: unknown,
): Promise<void> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, NO_EXISTE);
  if (!esUuid(outputId)) throw noExiste;
  const r = esquema.safeParse(entrada);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Datos inválidos.");
  const nuevo = r.data;

  const { data: actual, error } = await cliente
    .from("outputs")
    .select(COLUMNAS)
    .eq("id", outputId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle<OutputRow>();
  if (error) throw error;
  if (!actual) throw noExiste;
  if (
    actual.alias === nuevo.alias &&
    actual.duration_ms === nuevo.duration_ms &&
    actual.reader_mask === nuevo.reader_mask &&
    actual.enabled === nuevo.enabled
  ) {
    return;
  }
  const { data, error: errorEscritura } = await cliente
    .from("outputs")
    .update(nuevo)
    .eq("id", outputId)
    .is("deleted_at", null)
    .select("id");
  if (errorEscritura) throw errorEscritura;
  if (data.length === 0) throw noExiste;
}
