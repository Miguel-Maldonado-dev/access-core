import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type ApiActor, requireTenantRole } from "@/lib/auth/guards";
import { safeEqualHex, sha256Hex } from "@/lib/crypto";
import { HttpError } from "@/lib/errors";
import { createAdminSupabase } from "@/lib/supabase/admin";

/**
 * Llaves de la API pública (`/api/v1`). El secreto es `acc_` + 32 bytes aleatorios en
 * base64url (47 caracteres); solo se guarda su sha256 y un prefijo visible de 12 caracteres,
 * y se devuelve completo una sola vez, al crearlo o rotarlo.
 *
 * La gestión (crear, listar, revocar, rotar) exige admin del tenant con sesión de usuario;
 * la lectura va por RLS y las escrituras con la llave secreta, porque `authenticated` no
 * puede escribir en `api_keys`. `verifyApiKey` no tiene sesión: usa la llave secreta.
 */

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreatedApiKey {
  key: ApiKeyRow;
  /** Secreto completo: se muestra una sola vez. */
  secret: string;
}

export const MAX_API_KEY_NAME = 60;
export const MAX_LIVE_API_KEYS = 10;
const PREFIX_LENGTH = 12;
/** `last_used_at` se actualiza como máximo una vez por este intervalo. */
const LAST_USED_INTERVAL_MS = 60_000;

const SECRET_RE = /^acc_[A-Za-z0-9_-]{43}$/;
const COLUMNAS = "id, name, prefix, created_at, last_used_at, revoked_at";
const NO_EXISTE = "La llave no existe.";
const esUuid = (s: string) => z.guid().safeParse(s).success;

function nuevoSecreto(): { secret: string; prefix: string; keyHash: string } {
  const secret = `acc_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, PREFIX_LENGTH), keyHash: sha256Hex(secret) };
}

function parseName(valor: string): string {
  const nombre = valor.trim();
  if (nombre.length === 0) throw new HttpError(400, "Escribe el nombre de la llave.");
  if (nombre.length > MAX_API_KEY_NAME) {
    throw new HttpError(400, `El nombre admite hasta ${MAX_API_KEY_NAME} caracteres.`);
  }
  return nombre;
}

/** Crea una llave (admin). Con 10 llaves vivas en el tenant, 409. */
export async function createApiKeyAs(supabase: SupabaseClient, tenantId: string, name: string): Promise<CreatedApiKey> {
  const acceso = await requireTenantRole(tenantId, "admin", supabase);
  const nombre = parseName(name);
  const { secret, prefix, keyHash } = nuevoSecreto();
  const { data, error } = await createAdminSupabase()
    .rpc("create_api_key", {
      p_tenant_id: tenantId,
      p_name: nombre,
      p_prefix: prefix,
      p_key_hash: keyHash,
      p_created_by: acceso.userId,
    });
  if (error) {
    if (error.message === "api_key_limit") {
      throw new HttpError(409, `Ya hay ${MAX_LIVE_API_KEYS} llaves activas; revoca alguna.`);
    }
    throw error;
  }
  const key = (data as ApiKeyRow[] | null)?.[0];
  if (!key) throw new Error("create_api_key no devolvió la llave.");
  return { key, secret };
}

/** Llaves del tenant (vivas y revocadas), las más recientes primero, sin el hash (admin). */
export async function listApiKeysAs(supabase: SupabaseClient, tenantId: string): Promise<ApiKeyRow[]> {
  const acceso = await requireTenantRole(tenantId, "admin", supabase);
  const { data, error } = await acceso.supabase
    .from("api_keys")
    .select(COLUMNAS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .order("id")
    .overrideTypes<ApiKeyRow[], { merge: false }>();
  if (error) throw error;
  return data;
}

/** Revoca una llave viva del tenant (admin). Si no existe, es de otro tenant o ya estaba revocada, 404. */
export async function revokeApiKeyAs(supabase: SupabaseClient, tenantId: string, keyId: string): Promise<void> {
  await requireTenantRole(tenantId, "admin", supabase);
  if (!esUuid(keyId)) throw new HttpError(404, NO_EXISTE);
  const { data, error } = await createAdminSupabase()
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("tenant_id", tenantId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new HttpError(404, NO_EXISTE);
}

/**
 * Crea una llave con el mismo nombre y revoca la anterior en la misma transacción (admin).
 * Si la llave no existe, es de otro tenant o ya estaba revocada, 404.
 */
export async function rotateApiKeyAs(supabase: SupabaseClient, tenantId: string, keyId: string): Promise<CreatedApiKey> {
  const acceso = await requireTenantRole(tenantId, "admin", supabase);
  if (!esUuid(keyId)) throw new HttpError(404, NO_EXISTE);
  const { secret, prefix, keyHash } = nuevoSecreto();
  const { data, error } = await createAdminSupabase()
    .rpc("rotate_api_key", {
      p_tenant_id: tenantId,
      p_key_id: keyId,
      p_prefix: prefix,
      p_key_hash: keyHash,
      p_created_by: acceso.userId,
    });
  if (error) throw error;
  const key = (data as ApiKeyRow[] | null)?.[0];
  if (!key) throw new HttpError(404, NO_EXISTE);
  return { key, secret };
}

/**
 * Resuelve un secreto a su actor de API, o `null` si no tiene el formato, no existe, está
 * revocado o su tenant está suspendido (esta consulta no pasa por RLS, así que la
 * suspensión se comprueba aquí). Actualiza `last_used_at` como máximo una vez por minuto.
 * El secreto nunca se registra.
 */
export async function verifyApiKey(secret: string): Promise<ApiActor | null> {
  if (!SECRET_RE.test(secret)) return null;
  const keyHash = sha256Hex(secret);
  const admin = createAdminSupabase();
  const { data: llave, error } = await admin
    .from("api_keys")
    .select("id, tenant_id, name, key_hash, last_used_at, revoked_at, tenants!inner(suspended_at)")
    .eq("key_hash", keyHash)
    .maybeSingle<{
      id: string;
      tenant_id: string;
      name: string;
      key_hash: string;
      last_used_at: string | null;
      revoked_at: string | null;
      tenants: { suspended_at: string | null };
    }>();
  if (error) throw error;
  if (!llave || !safeEqualHex(keyHash, llave.key_hash) || llave.revoked_at !== null || llave.tenants.suspended_at !== null) {
    return null;
  }

  const ahora = Date.now();
  if (llave.last_used_at === null || ahora - Date.parse(llave.last_used_at) >= LAST_USED_INTERVAL_MS) {
    // Condicional en la base: con peticiones simultáneas, solo una escribe.
    const limite = new Date(ahora - LAST_USED_INTERVAL_MS).toISOString();
    const { error: errorUso } = await admin
      .from("api_keys")
      .update({ last_used_at: new Date(ahora).toISOString() })
      .eq("id", llave.id)
      .or(`last_used_at.is.null,last_used_at.lte.${limite}`);
    if (errorUso) throw errorUso;
  }

  return { kind: "api", tenantId: llave.tenant_id, keyId: llave.id, keyName: llave.name };
}
