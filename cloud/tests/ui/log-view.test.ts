import { describe, expect, it } from "vitest";
import {
  LOG_PAGE_SIZE,
  localDayStartUtc,
  logsHref,
  mediumLabel,
  outputLabel,
  parseLogFilters,
  reasonLabel,
  sourceLabel,
} from "@/lib/log-view";

describe("parseLogFilters", () => {
  it("sin parámetros no filtra y va en la página 1", () => {
    expect(parseLogFilters({})).toEqual({ page: 1 });
  });

  it("lee cada filtro de los parámetros de la URL", () => {
    const uuid = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
    expect(
      parseLogFilters({ desde: "2026-03-10", hasta: "2026-03-12", panel: uuid, titular: uuid, resultado: "denegado", origen: "3", pagina: "4" }),
    ).toEqual({ from: "2026-03-10", to: "2026-03-12", panelId: uuid, holderId: uuid, allowed: false, source: 3, page: 4 });
    expect(parseLogFilters({ resultado: "permitido" }).allowed).toBe(true);
  });

  it("ignora valores inválidos en vez de fallar", () => {
    expect(
      parseLogFilters({ desde: "2026-02-30", hasta: "ayer", panel: "x", titular: "y", resultado: "tal vez", origen: "9", pagina: "0" }),
    ).toEqual({ page: 1 });
    expect(parseLogFilters({ origen: "1.5", pagina: "-2" })).toEqual({ page: 1 });
    expect(parseLogFilters({ pagina: "abc" }).page).toBe(1);
  });

  it("toma el primer valor si el parámetro se repite", () => {
    expect(parseLogFilters({ origen: ["2", "3"] }).source).toBe(2);
  });
});

describe("logsHref", () => {
  it("arma una URL compartible solo con los filtros activos y la página si no es la 1", () => {
    expect(logsHref("/t/x/installations/y/logs", { page: 1 })).toBe("/t/x/installations/y/logs");
    expect(logsHref("/base", { source: 3, allowed: true, from: "2026-03-10", page: 1 })).toBe(
      "/base?desde=2026-03-10&resultado=permitido&origen=3",
    );
    expect(logsHref("/base", { source: 3, page: 1 }, 3)).toBe("/base?origen=3&pagina=3");
  });

  it("es inversa de parseLogFilters", () => {
    const f = { from: "2026-03-10", to: "2026-03-11", panelId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", allowed: false, source: 0, page: 2 };
    const url = new URL(logsHref("/b", f, 2), "http://x");
    expect(parseLogFilters(Object.fromEntries(url.searchParams))).toEqual(f);
  });
});

describe("localDayStartUtc", () => {
  it("convierte el inicio del día de México a UTC", () => {
    expect(localDayStartUtc("2026-03-10")).toBe("2026-03-10T06:00:00.000Z");
    // Hasta 2022 hubo horario de verano (UTC-5 de abril a octubre).
    expect(localDayStartUtc("2021-07-01")).toBe("2021-07-01T05:00:00.000Z");
  });
});

describe("etiquetas", () => {
  it("copian las del panel local", () => {
    expect(reasonLabel(0)).toBe("Permitido");
    expect(reasonLabel(10)).toBe("PIN bloqueado");
    expect(reasonLabel(42)).toBe("Motivo 42");
    expect(sourceLabel(3)).toBe("PIN");
    expect(sourceLabel(1)).toBe("Control RF");
    expect(sourceLabel(9)).toBe("Origen 9");
  });

  it("la salida muestra su alias y, sin alias, S1 a S4", () => {
    expect(outputLabel(0, "Pluma vehicular")).toBe("Pluma vehicular");
    expect(outputLabel(2, "")).toBe("S3");
    expect(outputLabel(3, null)).toBe("S4");
    expect(outputLabel(null, "Pluma")).toBe("-");
  });

  it("el medio nombra la credencial y el lector", () => {
    const base = { credential_label: null, control_id: null, device_id: null, reason: 0 };
    expect(mediumLabel({ ...base, source: 0, credential_label: "Tarjeta azul", device_id: 1 })).toBe("Tarjeta azul · L2");
    expect(mediumLabel({ ...base, source: 3, device_id: 0 })).toBe("PIN · L1");
    expect(mediumLabel({ ...base, source: 3 })).toBe("PIN");
    expect(mediumLabel({ ...base, source: 1, reason: 5 })).toBe("Control no registrado");
    expect(mediumLabel({ ...base, source: 1, credential_label: "Control Ana", device_id: 1 })).toBe("Control Ana · Botón 2");
    expect(mediumLabel({ ...base, source: 2, device_id: 0 })).toBe("Botón de salida 1");
  });

  it("la página es de 50", () => {
    expect(LOG_PAGE_SIZE).toBe(50);
  });
});
