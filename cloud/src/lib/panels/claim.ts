import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireTenantRole, requireUser } from "@/lib/auth/guards";
import { safeEqualHex, sha256Hex } from "@/lib/crypto";
import { HttpError } from "@/lib/errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Reclamar y revocar paneles como el usuario de la sesión (`supabase` con sesión).
 * La visibilidad se comprueba con RLS (cliente del usuario) y el rol con
 * `requireTenantRole`; las escrituras van con la llave secreta. Las server actions de
 * `app/t/[tenant]/installations/[id]/paneles/actions.ts` son envoltorios delgados.
 */

/** Intentos fallidos de reclamo permitidos por tenant en la última hora. */
export const MAX_CLAIM_ATTEMPTS = 10;
const VENTANA_INTENTOS_MS = 60 * 60 * 1000;

const ERROR_GENERICO = "El panel no existe o el código de vinculación es incorrecto.";
const esUuid = (s: string) => z.guid().safeParse(s).success;
const normalizar = (s: string) => s.trim().toUpperCase();

export interface ClaimedPanel {
  id: string;
  panel_code: string;
  status: "claimed";
  installation_id: string;
}

/**
 * Registra un intento antes de verificar el código y cuenta los de la última hora.
 * Contar después de insertar evita que peticiones simultáneas rebasen el límite.
 * Devuelve el id del intento (se borra si el reclamo sale bien).
 */
async function reservarIntento(admin: SupabaseClient, tenantId: string): Promise<number> {
  const ahora = Date.now();
  const desde = new Date(ahora - VENTANA_INTENTOS_MS).toISOString();

  const { error: errorLimpieza } = await admin
    .from("panel_claim_attempts")
    .delete()
    .eq("tenant_id", tenantId)
    .lt("at", desde);
  if (errorLimpieza) throw errorLimpieza;

  const { data: intento, error } = await admin
    .from("panel_claim_attempts")
    .insert({ tenant_id: tenantId, at: new Date(ahora).toISOString() })
    .select("id")
    .single<{ id: number }>();
  if (error) throw error;

  const { count, error: errorCuenta } = await admin
    .from("panel_claim_attempts")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .gte("at", desde);
  if (errorCuenta) throw errorCuenta;

  if ((count ?? 0) > MAX_CLAIM_ATTEMPTS) {
    // Al rebasar el límite el intento ni siquiera se verifica: no se cuenta.
    await admin.from("panel_claim_attempts").delete().eq("id", intento.id);
    throw new HttpError(429, "Demasiados intentos; espera una hora.");
  }
  return intento.id;
}

/**
 * Reclama un panel `pending` para una instalación (solo `admin` del tenant).
 * Normaliza `panelCode` y `claimCode` (trim y mayúsculas) y compara
 * sha256(claimCode) con `claim_code_hash` en tiempo constante. Panel inexistente,
 * código incorrecto o panel ya reclamado dan el mismo error 400 y cuentan como intento
 * fallido; con más de 10 en una hora por tenant responde 429.
 * Si el panel tenía salidas o reglas vivas en otra instalación (se revocó y se reclama en
 * una distinta), se borran lógicamente en la misma transacción; en la misma instalación
 * se conservan.
 */
export async function claimPanelAs(
  supabase: SupabaseClient,
  installationId: string,
  panelCode: string,
  claimCode: string,
): Promise<ClaimedPanel> {
  const { supabase: cliente } = await requireUser(supabase);

  const noExiste = new HttpError(404, "La instalación no existe.");
  if (!esUuid(installationId)) throw noExiste;
  const { data: instalacion, error: errorInst } = await cliente
    .from("installations")
    .select("id, tenant_id")
    .eq("id", installationId)
    .maybeSingle<{ id: string; tenant_id: string }>();
  if (errorInst) throw errorInst;
  if (!instalacion) throw noExiste;

  await requireTenantRole(instalacion.tenant_id, "admin", cliente);

  const admin = createAdminSupabase();
  const intentoId = await reservarIntento(admin, instalacion.tenant_id);

  const { data: panel, error } = await admin
    .from("panels")
    .select("id, status, claim_code_hash")
    .eq("panel_code", normalizar(panelCode))
    .maybeSingle<{ id: string; status: string; claim_code_hash: string | null }>();
  if (error) throw error;
  if (
    !panel?.claim_code_hash ||
    panel.status !== "pending" ||
    !safeEqualHex(sha256Hex(normalizar(claimCode)), panel.claim_code_hash)
  ) {
    throw new HttpError(400, ERROR_GENERICO);
  }

  // En una transacción (public.claim_panel): reclama el panel solo si sigue pendiente con
  // el mismo código (reclamos simultáneos) y borra lógicamente, con el autor neutro
  // 'system:reclamo' (la instalación anterior puede ser de otro tenant), las salidas y
  // reglas vivas que el panel dejó en otra instalación.
  const { data: reclamado, error: errorReclamo } = await admin.rpc("claim_panel", {
    p_panel_id: panel.id,
    p_claim_code_hash: panel.claim_code_hash,
    p_installation_id: instalacion.id,
  });
  if (errorReclamo) throw errorReclamo;
  if (!reclamado) throw new HttpError(400, ERROR_GENERICO);

  // Un reclamo exitoso no cuenta como intento fallido.
  const { error: errorIntento } = await admin.from("panel_claim_attempts").delete().eq("id", intentoId);
  if (errorIntento) throw errorIntento;
  return reclamado as ClaimedPanel;
}

/**
 * Revoca la credencial de un panel del tenant (solo `admin`): `status='revoked'` y
 * `device_token_hash=null`, y borra su `panel_imports`. Conserva la instalación hasta que el
 * panel se registre de nuevo. Un panel que el usuario no ve (inexistente, pendiente o de otro tenant) da 404.
 */
export async function revokePanelAs(supabase: SupabaseClient, panelId: string): Promise<void> {
  const { supabase: cliente } = await requireUser(supabase);

  const noExiste = new HttpError(404, "El panel no existe.");
  if (!esUuid(panelId)) throw noExiste;
  const { data: panel, error } = await cliente
    .from("panels")
    .select("id, tenant_id")
    .eq("id", panelId)
    .maybeSingle<{ id: string; tenant_id: string }>();
  if (error) throw error;
  if (!panel) throw noExiste;

  await requireTenantRole(panel.tenant_id, "admin", cliente);

  const admin = createAdminSupabase();
  const { error: errorRevocar } = await admin
    .from("panels")
    .update({ status: "revoked", device_token_hash: null })
    .eq("id", panel.id)
    .eq("tenant_id", panel.tenant_id);
  if (errorRevocar) throw errorRevocar;

  // El snapshot de una importación pendiente (nombres y PIN cifrados) no se conserva: un
  // panel revocado puede no volver nunca. Va después de revocar para no dejar un panel
  // en revisión sin su snapshot; si este borrado falla, revocar de nuevo lo completa.
  const { error: errorImport } = await admin.from("panel_imports").delete().eq("panel_id", panel.id);
  if (errorImport) throw errorImport;
}
