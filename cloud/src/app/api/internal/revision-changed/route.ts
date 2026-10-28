import { z } from "zod";
import { publishToPanel } from "@/lib/mqtt/publish";
import { headerMatchesEnv } from "@/lib/mqtt/secret";
import { createAdminSupabase } from "@/lib/supabase/admin";

const cuerpoSchema = z.object({
  installation_id: z.uuid(),
  revision: z.number().int().nonnegative(),
});

const sinCache = { "cache-control": "no-store" };

/**
 * POST /api/internal/revision-changed: lo llama la base de datos (pg_net) cuando cambia
 * la revisión de una instalación. Publica `{"type":"sync","revision":N}` a cada panel
 * activo. Si un publish falla sigue con los demás y responde un resumen.
 */
export async function POST(req: Request) {
  if (!headerMatchesEnv(req, "x-internal-secret", "INTERNAL_WEBHOOK_SECRET")) {
    return Response.json({ detail: "No autorizado." }, { status: 401, headers: sinCache });
  }
  const cuerpo = cuerpoSchema.safeParse(await req.json().catch(() => null));
  if (!cuerpo.success) {
    return Response.json({ detail: "El cuerpo del aviso no es válido." }, { status: 400, headers: sinCache });
  }

  const { data: paneles, error } = await createAdminSupabase()
    .from("panels")
    .select("panel_code")
    .eq("installation_id", cuerpo.data.installation_id)
    .eq("status", "active");
  if (error) {
    console.error("Error al listar los paneles activos:", error.code);
    return Response.json({ detail: "No se pudieron listar los paneles." }, { status: 500, headers: sinCache });
  }

  const resultados = await Promise.allSettled(
    paneles.map((p) => publishToPanel(p.panel_code, { type: "sync", revision: cuerpo.data.revision })),
  );
  const failed = resultados.filter((r) => r.status === "rejected");
  for (const r of failed) console.error("Falló un aviso de sincronización:", (r as PromiseRejectedResult).reason?.message);
  return Response.json(
    { panels: paneles.length, published: paneles.length - failed.length, failed: failed.length },
    { headers: sinCache },
  );
}
