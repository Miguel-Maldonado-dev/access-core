import { z } from "zod";
import { headerMatchesEnv } from "@/lib/mqtt/secret";
import { createAdminSupabase } from "@/lib/supabase/admin";

const eventoSchema = z.object({
  event: z.string(),
  username: z.string().nullish(),
  // Milisegundos desde la época: la hora del evento en el broker.
  timestamp: z.number().finite().optional(),
});

const sinCache = { "cache-control": "no-store" };

/**
 * POST /api/mqtt/events: webhook de la regla de EMQX para `client.connected` y
 * `client.disconnected`. Actualiza `online` y `last_seen_at` del panel (usuario MQTT =
 * panel_code) solo si el evento no es más viejo que el último aplicado.
 */
export async function POST(req: Request) {
  if (!headerMatchesEnv(req, "x-emqx-secret", "EMQX_WEBHOOK_SECRET")) {
    return Response.json({ detail: "No autorizado." }, { status: 401, headers: sinCache });
  }
  const cuerpo = eventoSchema.safeParse(await req.json().catch(() => null));
  if (!cuerpo.success) {
    return Response.json({ detail: "El cuerpo del evento no es válido." }, { status: 400, headers: sinCache });
  }
  const { event, username, timestamp } = cuerpo.data;
  const conectado = /^client[._]connected$/.test(event);
  const desconectado = /^client[._]disconnected$/.test(event);
  if ((!conectado && !desconectado) || !username) {
    return Response.json({ ignored: true }, { headers: sinCache });
  }

  const cuando = new Date(timestamp ?? Date.now()).toISOString();
  const { error } = await createAdminSupabase()
    .from("panels")
    .update({ online: conectado, last_seen_at: cuando, online_event_at: cuando })
    .eq("panel_code", username)
    .or(`online_event_at.is.null,online_event_at.lte.${cuando}`);
  if (error) {
    console.error("Error al registrar un evento de conexión MQTT:", error.code);
    return Response.json({ detail: "No se pudo registrar el evento." }, { status: 500, headers: sinCache });
  }
  return Response.json({ ok: true }, { headers: sinCache });
}
