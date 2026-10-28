import { createHash } from "node:crypto";

/**
 * Checksum de una tabla replicada, idéntico en la nube y en el panel (Python, P3).
 *
 * sha256 en hexadecimal de la concatenación de una línea por registro vivo, ordenada por
 * `id`. Cada línea es `id + "\t" + json_canónico(data) + "\n"`.
 *
 * El JSON canónico es el de Python
 * `json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`:
 * claves ordenadas (también en objetos anidados), sin espacios, UTF-8 sin escapar,
 * `true`/`false`/`null`. Las cadenas se escapan igual en los dos lados (`"`, `\` y los
 * caracteres de control U+0000..U+001F). Solo se aceptan enteros seguros: un número con
 * decimales se serializa distinto en Python (`1.0` frente a `1`) y el contrato no tiene.
 */

/** Comparación por unidades de código, como `sorted()` de Python con ids ASCII. */
function compararCadenas(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(valor: unknown): string {
  if (valor === null) return "null";
  switch (typeof valor) {
    case "boolean":
      return valor ? "true" : "false";
    case "string":
      return JSON.stringify(valor);
    case "number":
      if (!Number.isSafeInteger(valor)) {
        throw new Error(`JSON canónico: solo se admiten enteros (se recibió ${valor}).`);
      }
      return String(valor);
    case "object": {
      if (Array.isArray(valor)) return `[${valor.map(canonicalJson).join(",")}]`;
      const objeto = valor as Record<string, unknown>;
      const pares = Object.keys(objeto)
        .sort(compararCadenas)
        .map((clave) => `${JSON.stringify(clave)}:${canonicalJson(objeto[clave])}`);
      return `{${pares.join(",")}}`;
    }
    default:
      throw new Error(`JSON canónico: tipo no admitido (${typeof valor}).`);
  }
}

export function tableChecksum(rows: readonly { id: string; data: object }[]): string {
  const hash = createHash("sha256");
  for (const fila of [...rows].sort((a, b) => compararCadenas(a.id, b.id))) {
    hash.update(`${fila.id}\t${canonicalJson(fila.data)}\n`, "utf8");
  }
  return hash.digest("hex");
}
