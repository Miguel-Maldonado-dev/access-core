import { createBrowserClient } from "@supabase/ssr";

/** Cliente de Supabase para componentes de cliente (navegador). Usa solo la llave publicable. */
export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
