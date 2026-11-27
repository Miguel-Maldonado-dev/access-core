import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { z } from "zod";
import { guardPage, requireTenantRole, type DataClient } from "@/lib/auth/guards";
import { HttpError } from "@/lib/errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Instalaciones de un tenant como el usuario de la sesión (RLS: cualquier miembro lee y
 * renombra; solo el `admin` del tenant crea). `authenticated` no escribe `revision`.
 */

export interface Installation {
  id: string;
  name: string;
  revision: number;
}

export const MAX_INSTALLATION_NAME = 100;
const COLUMNAS = "id, name, revision";

function parseName(name: string): string {
  const limpio = name.trim();
  if (limpio === "") throw new HttpError(400, "Escribe el nombre de la instalación.");
  if (limpio.length > MAX_INSTALLATION_NAME) {
    throw new HttpError(400, `El nombre admite hasta ${MAX_INSTALLATION_NAME} caracteres.`);
  }
  return limpio;
}

/** Instalaciones del tenant (miembro; 403 si no lo es), por nombre. */
export async function listInstallationsAs(supabase: DataClient, tenantId: string): Promise<Installation[]> {
  const { supabase: cliente } = await requireTenantRole(tenantId, "tecnico", supabase);
  const { data, error } = await cliente
    .from("installations")
    .select(COLUMNAS)
    .eq("tenant_id", tenantId)
    .order("name");
  if (error) throw error;
  return data as Installation[];
}

/** Una instalación del tenant, o `null` si no existe o es de otro tenant. */
export async function getInstallationAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
): Promise<Installation | null> {
  const { supabase: cliente } = await requireTenantRole(tenantId, "tecnico", supabase);
  if (!z.guid().safeParse(installationId).success) return null;
  const { data, error } = await cliente
    .from("installations")
    .select(COLUMNAS)
    .eq("id", installationId)
    .eq("tenant_id", tenantId)
    .maybeSingle<Installation>();
  if (error) throw error;
  return data;
}

/** Crea una instalación (solo `admin` del tenant). */
export async function createInstallationAs(
  supabase: DataClient,
  tenantId: string,
  name: string,
): Promise<{ id: string }> {
  const { supabase: cliente } = await requireTenantRole(tenantId, "admin", supabase);
  const { data, error } = await cliente
    .from("installations")
    .insert({ tenant_id: tenantId, name: parseName(name) })
    .select("id")
    .single<{ id: string }>();
  if (error) throw error;
  return data;
}

/** Cambia el nombre de una instalación (cualquier miembro). 404 si no es del tenant. */
export async function renameInstallationAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  name: string,
): Promise<void> {
  const { supabase: cliente } = await requireTenantRole(tenantId, "tecnico", supabase);
  const limpio = parseName(name);
  const noExiste = new HttpError(404, "La instalación no existe.");
  if (!z.guid().safeParse(installationId).success) throw noExiste;
  const { data, error } = await cliente
    .from("installations")
    .update({ name: limpio })
    .eq("id", installationId)
    .eq("tenant_id", tenantId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw noExiste;
}

export interface QrSettings {
  /** Dígito de validación D de los códigos nuevos (1–9). */
  digit: number;
  /** Tope de QR vigentes de la instalación (1–100000). */
  max_active: number;
}

export const QR_MAX_ACTIVE = 100_000;

/** Ajustes de QR de la instalación (cualquier miembro). 404 si no es del tenant. */
export async function getQrSettingsAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
): Promise<QrSettings> {
  const { supabase: cliente } = await requireTenantRole(tenantId, "tecnico", supabase);
  const noExiste = new HttpError(404, "La instalación no existe.");
  if (!z.guid().safeParse(installationId).success) throw noExiste;
  const { data, error } = await cliente
    .from("installations")
    .select("qr_digit, qr_max_active")
    .eq("id", installationId)
    .eq("tenant_id", tenantId)
    .maybeSingle<{ qr_digit: number; qr_max_active: number }>();
  if (error) throw error;
  if (!data) throw noExiste;
  return { digit: data.qr_digit, max_active: data.qr_max_active };
}

/**
 * Cambia el dígito de QR y el tope de vigentes (solo `admin`). 422 si hay tarjetas vivas en
 * el rango del dígito nuevo. Los QR ya emitidos siguen valiendo.
 */
export async function setQrSettingsAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  ajustes: QrSettings,
): Promise<void> {
  const { supabase: cliente } = await requireTenantRole(tenantId, "admin", supabase);
  const noExiste = new HttpError(404, "La instalación no existe.");
  if (!z.guid().safeParse(installationId).success) throw noExiste;
  const digito = z.int().min(1).max(9).safeParse(ajustes?.digit);
  if (!digito.success) throw new HttpError(400, "El dígito de QR debe ser de 1 a 9.");
  const tope = z.int().min(1).max(QR_MAX_ACTIVE).safeParse(ajustes?.max_active);
  if (!tope.success) throw new HttpError(400, `El máximo de QR vigentes debe ser de 1 a ${QR_MAX_ACTIVE}.`);
  // La RPC no filtra por tenant: se comprueba antes que la instalación sea de este tenant.
  const { data: inst, error: errorInst } = await cliente
    .from("installations")
    .select("id")
    .eq("id", installationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (errorInst) throw errorInst;
  if (!inst) throw noExiste;
  const { error } = await cliente.rpc("set_installation_qr_settings", {
    p_installation: installationId,
    p_digit: digito.data,
    p_max_active: tope.data,
  });
  if (error) {
    if (error.code === "PT422") throw new HttpError(422, error.message);
    if (error.code === "42501") throw new HttpError(403, error.message);
    if (error.code === "P0002") throw noExiste;
    throw error;
  }
}

/**
 * Para páginas y layouts de /t/[tenant]/installations/[id]: la instalación del tenant de la
 * URL (con la sesión de la petición) o 404. `cache` la comparte entre el layout y la página.
 * Un no miembro recibe 403 (`guardPage`) antes de saber si la instalación existe.
 */
export const getInstallationForPage = cache(async (tenantId: string, installationId: string): Promise<Installation> => {
  const instalacion = await guardPage(getInstallationAs(await createServerSupabase(), tenantId, installationId));
  if (!instalacion) notFound();
  return instalacion;
});
