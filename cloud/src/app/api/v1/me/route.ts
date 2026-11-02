import { apiJson, apiRoute, llaveInvalida } from "@/lib/api/http";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * GET /api/v1/me (Bearer). Identifica la llave: `{tenant_id, key: {id, name, prefix}}`.
 */
export async function GET(req: Request) {
  return apiRoute(req, async (actor) => {
    const { data, error } = await createAdminSupabase()
      .from("api_keys")
      .select("id, name, prefix")
      .eq("id", actor.keyId)
      .eq("tenant_id", actor.tenantId)
      .maybeSingle<{ id: string; name: string; prefix: string }>();
    if (error) throw error;
    // Se borró entre la verificación y esta lectura.
    if (!data) throw llaveInvalida();
    return apiJson({ tenant_id: actor.tenantId, key: data });
  });
}
