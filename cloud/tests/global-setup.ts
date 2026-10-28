import { execFileSync } from "node:child_process";

/** Variables de Supabase que ven las pruebas: solo pueden venir del stack local. */
const VARIABLES_SUPABASE = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_LOCAL",
] as const;

/**
 * Las pruebas de integración usan SOLO el Supabase local (`supabase start`).
 * Primero se borran del entorno las variables de Supabase, para que ninguna prueba
 * llegue a un proyecto remoto exportado en el shell. Si el stack está arriba, se leen
 * su URL y sus llaves de `supabase status -o env` y se exportan con los mismos nombres
 * que usa la aplicación (no se lee `.env.local`). Si no está arriba, quedan sin definir:
 * las pruebas que no necesitan Supabase (p. ej. health) siguen funcionando y las de
 * integración fallan con un mensaje claro (`requireLocalSupabase()` en tests/helpers).
 */
export default function setup() {
  for (const nombre of VARIABLES_SUPABASE) delete process.env[nombre];

  let salida: string;
  try {
    salida = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    });
  } catch {
    return;
  }

  const vars: Record<string, string> = {};
  for (const linea of salida.split("\n")) {
    const m = /^([A-Z0-9_]+)="(.*)"$/.exec(linea.trim());
    if (m) vars[m[1]] = m[2];
  }
  if (!vars.API_URL || !vars.PUBLISHABLE_KEY || !vars.SECRET_KEY || !vars.DB_URL) return;

  process.env.NEXT_PUBLIC_SUPABASE_URL = vars.API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = vars.PUBLISHABLE_KEY;
  process.env.SUPABASE_SECRET_KEY = vars.SECRET_KEY;
  process.env.SUPABASE_DB_URL = vars.DB_URL;
  process.env.SUPABASE_LOCAL = "1";
}
