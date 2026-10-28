import type { TenantRole } from "@/lib/auth/guards";

/** Nombre de cada rol de tenant en la interfaz. */
export const ROLE_LABEL: Record<TenantRole, string> = {
  admin: "Administrador",
  tecnico: "Técnico",
};
