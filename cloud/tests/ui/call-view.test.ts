import { describe, expect, it } from "vitest";
import { CALL_LIMIT_MESSAGE, DEFAULT_OUTPUT_MESSAGE, normalizeCallSettings } from "@/lib/call-view";
import { HttpError } from "@/lib/errors";

const base = {
  enabled: true,
  mode: "menu",
  output_index: 0,
  menu_mask: 0b0011,
  default_output: 1,
  call_limit_per_minute: 3,
};

const mensaje = (entrada: unknown) => {
  try {
    normalizeCallSettings(entrada);
  } catch (e) {
    if (e instanceof HttpError) return e.message;
    throw e;
  }
  return "";
};

describe("normalizeCallSettings", () => {
  it("acepta una configuración válida", () => {
    expect(normalizeCallSettings(base)).toEqual(base);
  });

  it("rechaza una predeterminada fuera del menú con el texto del panel local", () => {
    expect(mensaje({ ...base, default_output: 3 })).toBe(DEFAULT_OUTPUT_MESSAGE);
    expect(DEFAULT_OUTPUT_MESSAGE).toBe("La salida predeterminada debe estar entre las salidas del menú.");
  });

  it("en «Una salida» ignora menú y predeterminada (los deja coherentes)", () => {
    const r = normalizeCallSettings({ ...base, mode: "single", menu_mask: 0b0001, default_output: 2 });
    expect(r.default_output).toBeNull();
    expect(r.menu_mask).toBe(0b0001);
  });

  it("el límite es un entero de 1 a 20", () => {
    for (const malo of [0, 21, 1.5, "3", null]) {
      expect(mensaje({ ...base, call_limit_per_minute: malo })).toBe(CALL_LIMIT_MESSAGE);
    }
    expect(normalizeCallSettings({ ...base, call_limit_per_minute: 20 }).call_limit_per_minute).toBe(20);
    expect(normalizeCallSettings({ ...base, call_limit_per_minute: 1 }).call_limit_per_minute).toBe(1);
  });

  it("rechaza modo, salida y máscara inválidos", () => {
    expect(mensaje({ ...base, mode: "otro" })).not.toBe("");
    expect(mensaje({ ...base, output_index: 4 })).not.toBe("");
    expect(mensaje({ ...base, menu_mask: 16 })).not.toBe("");
    expect(mensaje(null)).not.toBe("");
  });
});
