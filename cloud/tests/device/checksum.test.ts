import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, tableChecksum } from "@/lib/device/checksum";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("checksum de tabla", () => {
  it("vector fijo (el mismo que usa la prueba de Python de P3)", () => {
    const filas = [
      { id: "b", data: { x: 1 } },
      { id: "a", data: { y: true, a: "ñ" } },
    ];
    const texto = 'a\t{"a":"ñ","y":true}\nb\t{"x":1}\n';
    expect(tableChecksum(filas)).toBe(sha256(texto));
    expect(tableChecksum(filas)).toBe("026fefb4433323a03b0674781e012f222872a6e79f204d1e6c01364e39a0e227");
  });

  it("no depende del orden de entrada y una tabla vacía es el sha256 de la cadena vacía", () => {
    const filas = [
      { id: "c", data: { n: 3 } },
      { id: "a", data: { n: 1 } },
      { id: "b", data: { n: 2 } },
    ];
    expect(tableChecksum(filas)).toBe(tableChecksum([...filas].reverse()));
    expect(tableChecksum([])).toBe(sha256(""));
  });

  it("ordena por id con comparación de cadenas, no por configuración regional", () => {
    // "B" (0x42) va antes que "a" (0x61), como en sorted() de Python.
    const filas = [
      { id: "a", data: {} },
      { id: "B", data: {} },
    ];
    expect(tableChecksum(filas)).toBe(sha256("B\t{}\na\t{}\n"));
  });
});

describe("JSON canónico", () => {
  it("es idéntico a json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)", () => {
    // Salida de Python para el mismo objeto (claves anidadas ordenadas, null incluido,
    // UTF-8 sin escapar y caracteres de control escapados como \uXXXX).
    const datos = {
      b: 'a"\\\n\u0001\u007f é😀',
      a: null,
      c: [1, { z: false, y: null }],
    };
    expect(canonicalJson(datos)).toBe(
      '{"a":null,"b":"a\\"\\\\\\n\\u0001\u007f é😀","c":[1,{"y":null,"z":false}]}',
    );
  });

  it("rechaza valores que Python serializaría distinto", () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
    expect(() => canonicalJson({ x: undefined })).toThrow();
  });
});
