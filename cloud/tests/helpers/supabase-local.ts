import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Ayudas para las pruebas de integración contra el Supabase LOCAL.
 * tests/global-setup.ts exporta la URL y las llaves del stack local (o las borra si no está arriba).
 */

/** Falla con un mensaje claro si no hay Supabase local; llámala en `beforeAll`. */
export function requireLocalSupabase(): void {
  if (process.env.SUPABASE_LOCAL !== "1") {
    throw new Error(
      "Estas pruebas de integración necesitan el Supabase local: corre `supabase start` en cloud/ y vuelve a intentar.",
    );
  }
}

function entorno(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) throw new Error(`Falta ${nombre}: corre \`supabase start\` en cloud/.`);
  return valor;
}

const SIN_SESION_PERSISTENTE = { auth: { persistSession: false, autoRefreshToken: false } };

/** Cliente con la llave secreta del stack local (salta RLS): solo para preparar y limpiar datos. */
export function localAdmin(): SupabaseClient {
  return createClient(
    entorno("NEXT_PUBLIC_SUPABASE_URL"),
    entorno("SUPABASE_SECRET_KEY"),
    SIN_SESION_PERSISTENTE,
  );
}

/** Crea un usuario confirmado en el Auth local y devuelve su id. */
export async function createLocalUser(
  admin: SupabaseClient,
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`No se pudo crear el usuario de prueba ${email}: ${error?.message}`);
  return data.user.id;
}

/**
 * Inicia sesión con la llave publicable y devuelve un cliente con esa sesión:
 * sus consultas pasan por RLS como `authenticated`.
 */
export async function signInLocal(email: string, password: string): Promise<SupabaseClient> {
  const cliente = createClient(
    entorno("NEXT_PUBLIC_SUPABASE_URL"),
    entorno("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    SIN_SESION_PERSISTENTE,
  );
  const { error } = await cliente.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`No se pudo iniciar sesión como ${email}: ${error.message}`);
  return cliente;
}
