import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openapi } from "@/lib/api/openapi";

/** Guía de uso de la API: `cloud/docs/api.md` es la única fuente (no se copia a mano). */
export function leerGuia(): string {
  const md = readFileSync(join(process.cwd(), "docs", "api.md"), "utf8");
  // El título del documento ya lo muestra el visor con `info.title`.
  return md.replace(/^# .*\n+/, "").trim();
}

/**
 * Documento OpenAPI que recibe el visor de `/docs/api`: el mismo de `GET /api/v1/openapi.json`,
 * con la guía de `docs/api.md` como `info.description` (Markdown). El documento servido en
 * `/api/v1/openapi.json` no cambia.
 */
export function documentoParaVisor(): object {
  const base = openapi as { info: object };
  return { ...base, info: { ...base.info, description: leerGuia() } };
}
