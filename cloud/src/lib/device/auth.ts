import "server-only";
import { safeEqualHex, sha256Hex } from "@/lib/crypto";
import { DeviceApiError, unauthorized } from "@/lib/device/http";
import { createAdminSupabase } from "@/lib/supabase/admin";

/** `PNL-XXXX-XXXX` con el alfabeto Crockford base32 (sin I, L, O ni U). */
export const PANEL_CODE_RE = /^PNL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
/** sha256 en hexadecimal en minúsculas (como lo guarda `panels`). */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** `Authorization: Device <panel_code>.<device_token>`; el token es base64url de 32 bytes. */
const DEVICE_AUTH_RE = /^Device (PNL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\.([A-Za-z0-9_-]{43})$/;

/** Estados en los que el panel tiene credencial de dispositivo. */
export type DevicePanelStatus = "staging" | "awaiting_review" | "active";
const ESTADOS_CON_CREDENCIAL: readonly string[] = ["staging", "awaiting_review", "active"];

/** Panel autenticado: lo que necesitan las rutas de dispositivo (nunca los hashes). */
export interface Panel {
  id: string;
  panel_code: string;
  installation_id: string;
  tenant_id: string;
  status: DevicePanelStatus;
}

/**
 * Autentica una petición de la API de dispositivos.
 * Valida `Authorization: Device <panel_code>.<device_token>` contra `device_token_hash`
 * (en tiempo constante) y que el panel esté en `staging`, `awaiting_review` o `active`.
 * Cualquier otro caso lanza `DeviceApiError` 401 `unauthorized` (lo responde `deviceRoute`).
 * Actualiza `last_seen_at`. El token nunca se registra.
 */
export async function authenticateDevice(req: Request): Promise<Panel> {
  // Con cacheComponents, leer los headers de la petición hace dinámico un GET: Next
  // interrumpe su prerender y `deviceRoute` relanza esa interrupción (unstable_rethrow).
  const credencial = DEVICE_AUTH_RE.exec(req.headers.get("authorization") ?? "");
  if (!credencial) throw unauthorized();
  const [, panelCode, token] = credencial;

  const admin = createAdminSupabase();
  const { data: panel, error } = await admin
    .from("panels")
    .select("id, panel_code, installation_id, tenant_id, status, device_token_hash")
    .eq("panel_code", panelCode)
    .maybeSingle<Panel & { device_token_hash: string | null }>();
  if (error) throw error;
  if (
    !panel?.device_token_hash ||
    !safeEqualHex(sha256Hex(token), panel.device_token_hash) ||
    !ESTADOS_CON_CREDENCIAL.includes(panel.status)
  ) {
    throw unauthorized();
  }

  const { error: errorVisto } = await admin
    .from("panels")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", panel.id);
  if (errorVisto) throw errorVisto;

  return {
    id: panel.id,
    panel_code: panel.panel_code,
    installation_id: panel.installation_id,
    tenant_id: panel.tenant_id,
    status: panel.status,
  };
}

/**
 * Autentica como `authenticateDevice` y exige que el panel esté `active` (las rutas de
 * sincronización). En otro estado lanza 409 `not_active`.
 */
export async function authenticateActiveDevice(req: Request): Promise<Panel> {
  const panel = await authenticateDevice(req);
  if (panel.status !== "active") {
    throw new DeviceApiError(
      409,
      "not_active",
      "El panel todavía no está activo: termina su vinculación antes de sincronizar.",
    );
  }
  return panel;
}
