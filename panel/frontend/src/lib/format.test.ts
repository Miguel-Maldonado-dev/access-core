import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  holderKindLabel,
  mediumLabel,
  outputLabel,
  reasonLabel,
  sourceLabel,
} from "./format";
import type { LogItem } from "./types";

function log(over: Partial<LogItem>): LogItem {
  return {
    log_id: 1,
    timestamp: "2026-10-10T18:42:10-06:00",
    allowed: true,
    source: 0,
    holder_id: null,
    holder_name: null,
    holder_kind: null,
    credential_label: null,
    control_id: null,
    code: null,
    device_id: null,
    output_id: null,
    reason: 0,
    ...over,
  };
}

describe("format", () => {
  it("etiqueta motivos, orígenes, salidas y tipos", () => {
    expect(reasonLabel(5)).toBe("Control desconocido");
    expect(reasonLabel(0)).toBe("Permitido");
    expect(sourceLabel(2)).toBe("Botón de salida");
    expect(sourceLabel(0)).toBe("Tarjeta");
    expect(sourceLabel(1)).toBe("Control RF");
    expect(sourceLabel(3)).toBe("PIN");
    expect(reasonLabel(8)).toBe("PIN desconocido");
    expect(reasonLabel(9)).toBe("PIN no permitido");
    expect(reasonLabel(10)).toBe("PIN bloqueado");
    expect(outputLabel(3)).toBe("Relay4");
    expect(outputLabel(null)).toBe("-");
    expect(holderKindLabel("persona")).toBe("Persona");
    expect(holderKindLabel("domicilio")).toBe("Domicilio");
  });

  it("describe el medio de cada evento", () => {
    expect(mediumLabel(log({ source: 0, credential_label: "Tarjeta de Juan", device_id: 2 }))).toBe("Tarjeta de Juan · Reader3");
    expect(mediumLabel(log({ source: 0, credential_label: null, device_id: 0 }))).toBe("Tarjeta · Reader1");
    expect(mediumLabel(log({ source: 1, credential_label: "Control del coche rojo", control_id: 1, device_id: 0 }))).toBe("Control del coche rojo · Botón 1");
    expect(mediumLabel(log({ source: 1, credential_label: null, control_id: 4, device_id: 2 }))).toBe("Control 4 · Botón 3");
    expect(mediumLabel(log({ source: 1, reason: 5, control_id: null, device_id: null }))).toBe("Control no registrado");
    expect(mediumLabel(log({ source: 1, reason: 0, control_id: null, credential_label: "Control 1", device_id: 1 }))).toBe("Control 1 · Botón 2");
    expect(mediumLabel(log({ source: 1, reason: 0, control_id: null, credential_label: null, device_id: 0 }))).toBe("Control borrado · Botón 1");
    expect(mediumLabel(log({ source: 3, credential_label: "PIN", device_id: 1 }))).toBe("PIN · Reader2");
    expect(mediumLabel(log({ source: 3, credential_label: null, device_id: null }))).toBe("PIN");
    expect(mediumLabel(log({ source: 2, device_id: 1 }))).toBe("Botón de salida 2");
  });

  it("formatea fecha y hora en es-MX", () => {
    expect(formatDateTime("2026-10-10T18:42:10-06:00")).toMatch(/^10\/10\/2026,? 18:42:10$/);
  });
});
