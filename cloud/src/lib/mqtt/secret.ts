import "server-only";
import { safeEqualHex, sha256Hex } from "@/lib/crypto";

/**
 * Compara un encabezado de la petición con un secreto del entorno en tiempo constante
 * (se comparan los sha256 de ambos, así la longitud tampoco se filtra).
 * Falso si el encabezado falta o la variable de entorno no está definida.
 */
export function headerMatchesEnv(req: Request, header: string, envName: string): boolean {
  const esperado = process.env[envName];
  const recibido = req.headers.get(header);
  if (!esperado || !recibido) return false;
  return safeEqualHex(sha256Hex(recibido), sha256Hex(esperado));
}
