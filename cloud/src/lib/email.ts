import { z } from "zod";
import { HttpError } from "@/lib/errors";

/** Correo sin espacios y en minúsculas (como lo guarda Supabase Auth), o 400. */
export function parseEmail(valor: string): string {
  const email = valor.trim().toLowerCase();
  if (email.length > 254 || !z.email().safeParse(email).success) {
    throw new HttpError(400, "Escribe un correo válido.");
  }
  return email;
}
