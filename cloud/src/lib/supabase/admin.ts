import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Cliente con la llave secreta (SUPABASE_SECRET_KEY): se salta RLS. Solo servidor.
 * `server-only` hace fallar la compilación si lo importa un componente de cliente;
 * la comprobación de `window` es una segunda barrera en tiempo de ejecución.
 * Sin sesión: no guarda ni refresca tokens. `headers` se envía en cada petición (p. ej.
 * `x-acc-batch`, el token de un lote abierto de la API pública).
 */
export function createAdminSupabase(headers?: Record<string, string>) {
  if (typeof window !== "undefined") {
    throw new Error(
      "createAdminSupabase() solo puede usarse en el servidor: nunca en el navegador.",
    );
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const llave = process.env.SUPABASE_SECRET_KEY;
  if (!url || !llave) {
    throw new Error(
      "Falta NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SECRET_KEY en el entorno del servidor.",
    );
  }
  return createClient(url, llave, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(headers ? { global: { headers } } : {}),
  });
}
