import "server-only";
import { z } from "zod";

/** Cuerpo de `POST .../profiles`: la validación fina del nombre vive en `profiles.ts`. */
export const cuerpoCrearPerfil = z.strictObject({ name: z.string() });

/** Cuerpo de `PATCH .../profiles/{id}`: solo el nombre. */
export const cuerpoRenombrarPerfil = z.strictObject({ name: z.string().optional() });

/** Cuerpo de `PUT .../rules`: lista por panel; `rule: null` quita el acceso en ese panel. */
export const cuerpoReglas = z.array(z.strictObject({ panel_id: z.string(), rule: z.unknown() }));

/**
 * `allow_remote` es opcional en la API (clientes de la etapa 2A): una regla que llega sin él
 * conserva el valor guardado para ese panel, o `false` si la regla es nueva.
 */
export function conservarAllowRemote(
  cuerpo: z.infer<typeof cuerpoReglas>,
  vigentes: { panel_id: string; allow_remote: boolean }[],
): z.infer<typeof cuerpoReglas> {
  return cuerpo.map((e) => {
    const r = e.rule;
    if (r === null || typeof r !== "object" || Array.isArray(r) || "allow_remote" in r) return e;
    const actual = vigentes.find((v) => v.panel_id === e.panel_id)?.allow_remote ?? false;
    return { ...e, rule: { ...r, allow_remote: actual } };
  });
}

/** Cuerpo de `PUT .../holders`. */
export const cuerpoTitularesPerfil = z.strictObject({ holder_ids: z.array(z.string()) });
