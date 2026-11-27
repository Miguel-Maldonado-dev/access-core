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
    expect(sourceLabel(5)).toBe("Prueba");
    expect(sourceLabel(1)).toBe("Control RF");
    expect(sourceLabel(3)).toBe("PIN");
    expect(reasonLabel(8)).toBe("PIN desconocido");
    expect(reasonLabel(9)).toBe("PIN no permitido");
    expect(reasonLabel(10)).toBe("PIN bloqueado");
    expect(sourceLabel(4)).toBe("Remota");
    expect(reasonLabel(11)).toBe("Titular desconocido");
    expect(sourceLabel(6)).toBe("Llamada");
    expect(reasonLabel(12)).toBe("Teléfono desconocido");
    expect(reasonLabel(13)).toBe("Límite de llamadas");
    expect(sourceLabel(7)).toBe("QR");
    expect(reasonLabel(14)).toBe("QR desconocido");
    expect(reasonLabel(15)).toBe("QR fuera de vigencia");
    expect(reasonLabel(16)).toBe("QR ya usado en este lector");
    expect(reasonLabel(17)).toBe("Método no permitido en este lector");
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
    expect(mediumLabel(log({ source: 5, credential_label: "Prueba — web local" }))).toBe("Prueba — web local");
    expect(mediumLabel(log({ source: 5, credential_label: null }))).toBe("Prueba");
    expect(mediumLabel(log({ source: 4, credential_label: "App Vecinos · Ana" }))).toBe("App Vecinos · Ana");
    expect(mediumLabel(log({ source: 4, credential_label: null }))).toBe("Remota");
    expect(mediumLabel(log({ source: 6, credential_label: "5512345678", device_id: 2 }))).toBe("5512345678 · tecla 2");
    expect(mediumLabel(log({ source: 6, credential_label: "5512345678", device_id: null }))).toBe("5512345678");
    expect(mediumLabel(log({ source: 6, credential_label: null }))).toBe("Llamada");
  });

  it("formatea fecha y hora en es-MX", () => {
    expect(formatDateTime("2026-10-10T18:42:10-06:00")).toMatch(/^10\/10\/2026,? 18:42:10$/);
  });

  it("describe el medio de un QR", () => {
    expect(mediumLabel(log({ source: 7, credential_label: "Visita de Ana", device_id: 1 }))).toBe("Visita de Ana · Reader2");
    expect(mediumLabel(log({ source: 7, code: 912345678, device_id: null }))).toBe("QR");
  });
});
