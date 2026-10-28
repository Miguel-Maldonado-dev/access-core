import { z } from "zod";
import { safeEqualHex, sha256Hex } from "@/lib/crypto";
import { PANEL_CODE_RE } from "@/lib/device/auth";
import { headerMatchesEnv } from "@/lib/mqtt/secret";
import { createAdminSupabase } from "@/lib/supabase/admin";

/** Estados con credencial de dispositivo: pueden conectarse al broker. */
const ESTADOS_CON_CREDENCIAL = ["staging", "awaiting_review", "active"];

const cuerpoSchema = z.object({ username: z.string(), clientid: z.string(), password: z.string() });

const respuesta = (result: "allow" | "deny") =>
  Response.json({ result }, { headers: { "cache-control": "no-store" } });

/**
 * POST /api/mqtt/auth: autenticación HTTP de EMQX. Usuario = panel_code = clientid, contraseña =
 * device_token. El clientid debe ser el propio panel_code: así nadie con una credencial válida
 * puede usar el clientid de otro panel y expulsar su sesión. Cualquier fallo es `deny` (EMQX
 * espera 200 con el resultado). Exige `x-emqx-secret`. Nunca se registran usuario ni contraseña.
 */
export async function POST(req: Request) {
  if (!headerMatchesEnv(req, "x-emqx-secret", "EMQX_WEBHOOK_SECRET")) return respuesta("deny");
  const cuerpo = cuerpoSchema.safeParse(await req.json().catch(() => null));
  if (
    !cuerpo.success ||
    !PANEL_CODE_RE.test(cuerpo.data.username) ||
    cuerpo.data.clientid !== cuerpo.data.username
  )
    return respuesta("deny");

  const { data: panel, error } = await createAdminSupabase()
    .from("panels")
    .select("status, device_token_hash")
    .eq("panel_code", cuerpo.data.username)
    .maybeSingle();
  if (error) {
    console.error("Error al autenticar un panel MQTT:", error.code);
    return respuesta("deny");
  }
  const valido =
    !!panel?.device_token_hash &&
    safeEqualHex(sha256Hex(cuerpo.data.password), panel.device_token_hash) &&
    ESTADOS_CON_CREDENCIAL.includes(panel.status);
  return respuesta(valido ? "allow" : "deny");
}
