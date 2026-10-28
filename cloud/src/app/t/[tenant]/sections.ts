import type { TenantRole } from "@/lib/auth/guards";

/**
 * Pestañas del tenant, en orden. `segment` es la carpeta bajo `app/t/[tenant]/` y
 * `minRole` el rol mínimo para verla (`tecnico` la ve también un `admin`). Las tareas
 * siguientes agregan aquí sus secciones (perfiles, logs, conflictos…). Ocultar una pestaña
 * no protege la página: cada página comprueba su rol.
 */
export const TENANT_SECTIONS: { segment: string; label: string; minRole: TenantRole }[] = [
  { segment: "installations", label: "Instalaciones", minRole: "tecnico" },
  { segment: "users", label: "Usuarios", minRole: "admin" },
];
