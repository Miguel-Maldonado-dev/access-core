import "server-only";
import { cache } from "react";
import { guardPage, isPlatformAdmin, requireUser } from "@/lib/auth/guards";

/** Quien ve la página: lo que necesitan el encabezado y el inicio. */
export interface Viewer {
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
}

/**
 * Usuario de la sesión para páginas y layouts (sin sesión lleva a /login). `cache` lo
 * comparte entre el encabezado y la página dentro de la misma petición.
 */
export const getViewer = cache(async (): Promise<Viewer> => {
  const { userId, email } = await guardPage(requireUser());
  return { userId, email, isPlatformAdmin: await isPlatformAdmin(userId) };
});
