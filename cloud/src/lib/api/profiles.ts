import "server-only";
import { z } from "zod";

/** Cuerpo de `POST .../profiles`: la validación fina del nombre vive en `profiles.ts`. */
export const cuerpoCrearPerfil = z.strictObject({ name: z.string() });

/** Cuerpo de `PATCH .../profiles/{id}`: solo el nombre. */
export const cuerpoRenombrarPerfil = z.strictObject({ name: z.string().optional() });

/** Cuerpo de `PUT .../rules`: lista por panel; `rule: null` quita el acceso en ese panel. */
export const cuerpoReglas = z.array(z.strictObject({ panel_id: z.string(), rule: z.unknown() }));

/** Cuerpo de `PUT .../holders`. */
export const cuerpoTitularesPerfil = z.strictObject({ holder_ids: z.array(z.string()) });
