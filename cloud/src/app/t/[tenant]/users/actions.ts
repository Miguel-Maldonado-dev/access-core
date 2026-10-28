"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-rules";
import {
  addMemberAs,
  changeMemberRoleAs,
  removeMemberAs,
  type AccountResult,
  type MemberChange,
} from "@/lib/tenants/members";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions de /t/[tenant]/users (solo `admin` del tenant). Envoltorios delgados: la
 * autorización y la lógica están en `@/lib/tenants/members`. Quien se degrada o se quita a
 * sí mismo pierde esta página, así que se le lleva al inicio.
 */

const texto = z.string().max(320);
const rol = z.enum(["admin", "tecnico"]);
const contrasena = z.string().max(MAX_PASSWORD_LENGTH);

/** Da de alta, con su cuenta, a un miembro con el rol elegido. La contraseña no se registra ni se devuelve. */
export async function addMember(
  tenantId: string,
  email: string,
  password: string,
  role: "admin" | "tecnico",
): Promise<ActionResult<AccountResult>> {
  const datos = z.tuple([texto, texto, contrasena, rol]).safeParse([tenantId, email, password, role]);
  if (!datos.success) return INVALID_DATA;
  return runAction(async () => addMemberAs(await createServerSupabase(), ...datos.data));
}

/** Cambia el rol de un miembro; degradar al último admin devuelve el error. */
export async function changeMemberRole(
  tenantId: string,
  userId: string,
  role: "admin" | "tecnico",
): Promise<ActionResult<MemberChange>> {
  const datos = z.tuple([texto, texto, rol]).safeParse([tenantId, userId, role]);
  if (!datos.success) return INVALID_DATA;
  const resultado = await runAction(async () => changeMemberRoleAs(await createServerSupabase(), ...datos.data));
  if (resultado.ok && resultado.data.self && role !== "admin") redirect("/");
  return resultado;
}

/** Quita a un miembro del tenant; quitar al último admin devuelve el error. */
export async function removeMember(tenantId: string, userId: string): Promise<ActionResult<MemberChange>> {
  const datos = z.tuple([texto, texto]).safeParse([tenantId, userId]);
  if (!datos.success) return INVALID_DATA;
  const resultado = await runAction(async () => removeMemberAs(await createServerSupabase(), ...datos.data));
  if (resultado.ok && resultado.data.self) redirect("/");
  return resultado;
}
