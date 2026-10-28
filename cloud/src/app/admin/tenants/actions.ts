"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-rules";
import {
  addTenantAdminAs,
  createTenantAs,
  setTenantSuspendedAs,
  type CreatedTenant,
} from "@/lib/tenants/admin";
import type { AccountResult } from "@/lib/tenants/members";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions de /admin/tenants (solo súper administrador). Envoltorios delgados: la
 * autorización y la lógica están en `@/lib/tenants/admin`. La contraseña viaja solo en la
 * petición de la acción: no se registra ni se devuelve.
 */

const texto = z.string().max(320);
const contrasena = z.string().max(MAX_PASSWORD_LENGTH);

/** Crea un tenant y la cuenta (ya confirmada) de su primer administrador. */
export async function createTenant(
  name: string,
  adminEmail: string,
  password: string,
): Promise<ActionResult<CreatedTenant>> {
  const datos = z.tuple([texto, texto, contrasena]).safeParse([name, adminEmail, password]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => createTenantAs(await createServerSupabase(), ...datos.data));
}

/** Suspende (`true`) o reactiva (`false`) un tenant. */
export async function setTenantSuspended(tenantId: string, suspended: boolean): Promise<ActionResult> {
  const datos = z.tuple([texto, z.boolean()]).safeParse([tenantId, suspended]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => setTenantSuspendedAs(await createServerSupabase(), ...datos.data));
}

/** Da de alta, con su cuenta, a otro administrador de un tenant. */
export async function addTenantAdmin(
  tenantId: string,
  email: string,
  password: string,
): Promise<ActionResult<AccountResult>> {
  const datos = z.tuple([texto, texto, contrasena]).safeParse([tenantId, email, password]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => addTenantAdminAs(await createServerSupabase(), ...datos.data));
}
