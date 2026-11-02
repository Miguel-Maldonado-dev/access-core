import "server-only";
import { z } from "zod";

/** Botón de un control: la validación fina (rangos, paneles) vive en `controls.ts`. */
const boton = z.strictObject({
  id: z.string().nullable().optional(),
  button: z.number(),
  rf_code: z.number().nullable().optional(),
  outputs: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
});

/** Cuerpo de `POST` de controles (`ControlInput`); sin `description` queda vacía. */
export const cuerpoControl = z.strictObject({
  holder_id: z.string(),
  description: z.string().optional(),
  buttons: z.array(boton),
});

/** Cuerpo de `PUT`: reemplaza la descripción, así que es obligatoria (omitirla la borraría). */
export const cuerpoControlPut = z.strictObject({ ...cuerpoControl.shape, description: z.string() });
