import { describe, expect, it } from "vitest";
import { hhmmToMinutes, minutesToHHMM } from "./time";

describe("time", () => {
  it("convierte minutos a HH:MM", () => {
    expect(minutesToHHMM(1080)).toBe("18:00");
    expect(minutesToHHMM(5)).toBe("00:05");
  });
  it("convierte HH:MM a minutos", () => {
    expect(hhmmToMinutes("08:30")).toBe(510);
    expect(hhmmToMinutes("23:59")).toBe(1439);
  });
  it("rechaza horarios inválidos", () => {
    expect(() => hhmmToMinutes("24:00")).toThrow("Horario inválido: usa HH:MM");
    expect(() => hhmmToMinutes("")).toThrow("Horario inválido: usa HH:MM");
    expect(() => hhmmToMinutes("8:3")).toThrow("Horario inválido: usa HH:MM");
  });
});
