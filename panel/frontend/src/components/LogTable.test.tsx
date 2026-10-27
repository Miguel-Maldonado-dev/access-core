import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import LogTable from "./LogTable";
import type { LogItem } from "@/lib/types";

const denied: LogItem = {
  log_id: 1,
  timestamp: "2026-10-10T12:30:00-06:00",
  allowed: false,
  source: 1,
  holder_id: 1,
  holder_name: "Amadeo 1260",
  holder_kind: "domicilio",
  credential_label: "Control del coche rojo",
  control_id: 4,
  code: 10387716,
  device_id: 2,
  output_id: 2,
  reason: 3,
};

const unknown: LogItem = {
  ...denied,
  log_id: 2,
  holder_id: null,
  holder_name: null,
  holder_kind: null,
  credential_label: null,
  control_id: null,
  output_id: null,
  reason: 5,
};

describe("LogTable", () => {
  it("muestra exactamente las 7 columnas", () => {
    render(<LogTable items={[]} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Fecha", "Resultado", "Titular", "Medio de acceso", "Código", "Salida", "Motivo"]);
  });

  it("muestra un log denegado de un domicilio", () => {
    render(<LogTable items={[denied]} />);
    const row = screen.getAllByRole("row")[1];
    for (const text of ["DENEGADO", "Amadeo 1260 · Domicilio", "Control del coche rojo · Botón 3", "10387716", "Relay3", "Sin permiso"]) {
      expect(within(row).getByText(text)).toBeInTheDocument();
    }
  });

  it("un log sin titular muestra - y conserva el código", () => {
    render(<LogTable items={[unknown]} />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getAllByText("-").length).toBeGreaterThan(0);
    expect(within(row).getByText("10387716")).toBeInTheDocument();
  });

  it("explica cuando no hay registros", () => {
    render(<LogTable items={[]} />);
    expect(screen.getByText("No hay registros con estos filtros.")).toBeInTheDocument();
  });
});
