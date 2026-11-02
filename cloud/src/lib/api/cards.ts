import "server-only";
import { z } from "zod";

/** Cuerpo de `POST .../cards`: la validación fina vive en `cards.ts`. */
export const cuerpoCrearTarjeta = z.strictObject({
  card_code: z.number(),
  holder_id: z.string(),
  description: z.string().optional(),
});

/** Cuerpo de `PATCH .../cards/{id}`: el código no se edita. */
export const cuerpoEditarTarjeta = z.strictObject({
  holder_id: z.string().optional(),
  description: z.string().optional(),
});
