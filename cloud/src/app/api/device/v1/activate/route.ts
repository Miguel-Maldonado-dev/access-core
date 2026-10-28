import { z } from "zod";
import { newDeviceToken, safeEqualHex, sha256Hex } from "@/lib/crypto";
import { PANEL_CODE_RE } from "@/lib/device/auth";
import {
  DeviceApiError,
  deviceJson,
  deviceRoute,
  readJsonBody,
  unauthorized,
} from "@/lib/device/http";
import { createAdminSupabase } from "@/lib/supabase/admin";

const esquema = z.object({
  panel_code: z.string().regex(PANEL_CODE_RE),
  // 32 bytes en hexadecimal; solo viaja en esta llamada.
  panel_secret: z.string().regex(/^[0-9a-f]{64}$/),
});

function yaActivado() {
  return new DeviceApiError(409, "already_activated", "El panel ya se activó; usa su credencial.");
}

/**
 * POST /api/device/v1/activate (sin autenticación; prueba de identidad con `panel_secret`).
 * - Secreto incorrecto o panel inexistente: 401 `unauthorized`.
 * - `pending` (sin reclamar): 202 `{status:"pending"}`.
 * - `claimed`: genera la credencial, guarda solo su hash, pasa a `staging` y responde 200
 *   `{device_token, installation_id, installation_name}`. El token se entrega una sola vez.
 * - `staging` o más adelante: 409 `already_activated`. `revoked`: 410 `revoked`.
 */
export async function POST(req: Request) {
  return deviceRoute(async () => {
    const cuerpo = await readJsonBody(req, esquema);
    const admin = createAdminSupabase();

    const { data: panel, error } = await admin
      .from("panels")
      .select("id, status, panel_secret_hash")
      .eq("panel_code", cuerpo.panel_code)
      .maybeSingle<{ id: string; status: string; panel_secret_hash: string }>();
    if (error) throw error;
    if (!panel || !safeEqualHex(sha256Hex(cuerpo.panel_secret), panel.panel_secret_hash)) {
      throw unauthorized();
    }

    switch (panel.status) {
      case "pending":
        return deviceJson({ status: "pending" }, 202);
      case "revoked":
        throw new DeviceApiError(410, "revoked", "El panel fue revocado; debe registrarse de nuevo.");
      case "claimed":
        break;
      default:
        throw yaActivado();
    }

    const token = newDeviceToken();
    // Condicionado a `claimed`: si dos activaciones compiten, solo una recibe token.
    const { data: activado, error: errorActivar } = await admin
      .from("panels")
      .update({ device_token_hash: sha256Hex(token), status: "staging" })
      .eq("id", panel.id)
      .eq("status", "claimed")
      .select("installation_id, installation:installations(name)")
      .maybeSingle<{ installation_id: string; installation: { name: string } }>();
    if (errorActivar) throw errorActivar;
    if (!activado) throw yaActivado();

    return deviceJson({
      device_token: token,
      installation_id: activado.installation_id,
      installation_name: activado.installation.name,
    });
  });
}
