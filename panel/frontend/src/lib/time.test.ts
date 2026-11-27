import { describe, expect, it } from "vitest";
import { hhmmToMinutes, isoToMexicoLocal, mexicoLocalToIso, minutesToHHMM } from "./time";

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
  it("convierte hora de México a ISO UTC", () => {
    expect(mexicoLocalToIso("2026-12-01T09:00")).toBe("2026-12-01T15:00:00.000Z");
    expect(mexicoLocalToIso("2026-12-31T20:00")).toBe("2027-01-01T02:00:00.000Z");
  });
  it("convierte ISO UTC a hora de México", () => {
    expect(isoToMexicoLocal("2026-12-01T15:00:00Z")).toBe("2026-12-01T09:00");
    expect(isoToMexicoLocal("2027-01-01T02:00:00.000Z")).toBe("2026-12-31T20:00");
  });
});
