import { refresh } from "next/cache";
import { HttpError } from "@/lib/errors";

/**
 * Resultado de las server actions de la interfaz: devuelven el error en vez de lanzarlo,
 * para que el componente lo muestre. Solo los `HttpError` (mensajes en español aptos para
 * el usuario) se convierten en resultado; los demás errores se propagan como internos.
 */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export const INVALID_DATA: ActionResult<never> = { ok: false, status: 400, error: "Datos inválidos." };

/**
 * Ejecuta la acción, refresca la vista si sale bien y traduce los `HttpError`. Solo en
 * server actions. `{ refresh: false }` no refresca: para las que solo consultan o cuya
 * página se refresca desde el cliente (las órdenes a los paneles).
 */
export async function runAction<T>(
  accion: () => Promise<T>,
  opciones: { refresh?: boolean } = {},
): Promise<ActionResult<T>> {
  try {
    const data = await accion();
    if (opciones.refresh !== false) refresh();
    return { ok: true, data };
  } catch (error) {
    if (error instanceof HttpError) {
      return { ok: false, status: error.status, error: error.message };
    }
    throw error;
  }
}
