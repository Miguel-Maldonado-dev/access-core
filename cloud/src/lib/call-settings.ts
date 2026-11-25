import "server-only";
import { autoria, type DataClient } from "@/lib/auth/guards";
import { esUuid, fetchAll, livePanelIds, requireInstallationAccess } from "@/lib/access-data";
import { normalizeCallSettings, type CallSettingsRow } from "@/lib/call-view";
import { HttpError } from "@/lib/errors";

/**
 * Configuración del módulo de llamadas por panel como el usuario de la sesión (RLS). Las filas
 * las crean el vínculo y la importación del panel: aquí solo se leen y se editan (nunca se
 * crean ni se borran). Leer: técnico o más. Editar: solo admin.
 */

export type { CallSettingsInput, CallSettingsRow } from "@/lib/call-view";

const COLUMNAS = "id, panel_id, enabled, mode, output_index, menu_mask, default_output, call_limit_per_minute";
const NO_EXISTE = "La configuración de llamadas no existe.";

/** Configuraciones vivas de los paneles vigentes de la instalación, por panel (cualquier miembro). */
export async function listCallSettingsAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
): Promise<CallSettingsRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const [filas, vigentes] = await Promise.all([
    fetchAll<CallSettingsRow>((desde, hasta) =>
      cliente
        .from("panel_call_settings")
        .select(COLUMNAS)
        .eq("installation_id", installationId)
        .is("deleted_at", null)
        .order("panel_id")
        .order("id")
        .range(desde, hasta),
    ),
    livePanelIds(cliente, installationId),
  ]);
  return filas.filter((f) => vigentes.has(f.panel_id));
}

/** Edita la configuración de un panel (solo admin). Si nada cambió no escribe (cada escritura avisa al panel). */
export async function updateCallSettingsAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  settingsId: string,
  entrada: unknown,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "admin");
  const cliente = acceso.supabase;
  const noExiste = new HttpError(404, NO_EXISTE);
  if (!esUuid(settingsId)) throw noExiste;
  const nuevo = normalizeCallSettings(entrada);

  const { data: actual, error } = await cliente
    .from("panel_call_settings")
    .select(COLUMNAS)
    .eq("id", settingsId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle<CallSettingsRow>();
  if (error) throw error;
  if (!actual) throw noExiste;
  if (
    actual.enabled === nuevo.enabled &&
    actual.mode === nuevo.mode &&
    actual.output_index === nuevo.output_index &&
    actual.menu_mask === nuevo.menu_mask &&
    actual.default_output === nuevo.default_output &&
    actual.call_limit_per_minute === nuevo.call_limit_per_minute
  ) {
    return;
  }
  const { data, error: errorEscritura } = await cliente
    .from("panel_call_settings")
    .update({ ...nuevo, ...autoria(acceso) })
    .eq("id", settingsId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (errorEscritura) throw errorEscritura;
  if (data.length === 0) throw noExiste;
}
