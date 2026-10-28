import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";

/**
 * Cliente de Supabase con la sesión del usuario (cookies). Solo servidor:
 * Server Components, Server Actions y Route Handlers. Crear uno por petición.
 *
 * `connection()` deja todo lo que usa la sesión para el momento de la petición: Auth
 * compara la caducidad del token con `Date.now()`, que Cache Components no admite al
 * prerenderizar aunque ya haya cookies.
 */
export async function createServerSupabase() {
  await connection();
  const almacen = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return almacen.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              almacen.set(name, value, options),
            );
          } catch {
            // Un Server Component no puede escribir cookies; el proxy
            // (src/proxy.ts, tarea N11) refresca la sesión en cada petición.
          }
        },
      },
    },
  );
}
