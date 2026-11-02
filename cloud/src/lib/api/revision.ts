import "server-only";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Revisión actual de una instalación. La ruta ya validó que pertenece al tenant de la llave
 * con la capa de datos; aquí solo se lee con la llave secreta.
 */
export async function currentRevision(installationId: string): Promise<number> {
  const { data, error } = await createAdminSupabase()
    .from("installations")
    .select("revision")
    .eq("id", installationId)
    .single<{ revision: number }>();
  if (error) throw error;
  return data.revision;
}
