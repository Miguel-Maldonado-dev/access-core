import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireInstallationAccess } from "@/lib/access-data";
import { HttpError } from "@/lib/errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Eliminación de una instalación (solo admin del tenant). Exige escribir su nombre; el borrado
 * físico de todos sus datos y de sus paneles lo hace la función `delete_installation` en una
 * transacción, con la llave secreta. Cada panel eliminado recibe 401 en su siguiente llamada,
 * borra su credencial, conserva su base local y vuelve a registrarse como pendiente.
 */
export async function deleteInstallationAs(
  supabase: SupabaseClient,
  tenantId: string,
  installationId: string,
  confirmName: string,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "admin");

  const { data: instalacion, error: errorNombre } = await acceso.supabase
    .from("installations")
    .select("name")
    .eq("id", installationId)
    .eq("tenant_id", tenantId)
    .maybeSingle<{ name: string }>();
  if (errorNombre) throw errorNombre;
  if (!instalacion || String(confirmName).trim() !== instalacion.name) {
    throw new HttpError(400, "El nombre no coincide con la instalación.");
  }

  const { data: borrada, error } = await createAdminSupabase().rpc("delete_installation", {
    p_installation: installationId,
  });
  if (error) throw error;
  if (borrada !== true) throw new HttpError(404, "La instalación no existe.");
}
