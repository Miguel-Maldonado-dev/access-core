import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ClockBadge from "./ClockBadge";

function mockClock(ntp: boolean | null, timezone = "America/Mexico_City") {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ now: "2026-10-10T18:42:10-06:00", timezone, ntp_synchronized: ntp }),
      { status: 200 },
    ),
  );
}

describe("ClockBadge", () => {
  afterEach(() => vi.restoreAllMocks());

  it("avisa cuando la hora no está sincronizada", async () => {
    mockClock(false);
    render(<ClockBadge />);
    expect(
      await screen.findByText("La hora de la placa no está sincronizada; los horarios de los permisos pueden aplicarse mal."),
    ).toBeInTheDocument();
  });

  it("avisa cuando se desconoce la sincronización", async () => {
    mockClock(null);
    render(<ClockBadge />);
    expect(await screen.findByText("Sincronización desconocida")).toBeInTheDocument();
  });

  it("muestra la hora sin aviso cuando está sincronizada", async () => {
    mockClock(true);
    render(<ClockBadge />);
    expect(await screen.findByText(/18:42:10/)).toBeInTheDocument();
    expect(screen.queryByText(/no está sincronizada/)).toBeNull();
    expect(screen.queryByText("Sincronización desconocida")).toBeNull();
  });

  it("avisa cuando la placa no está en America/Mexico_City", async () => {
    mockClock(true, "UTC");
    render(<ClockBadge />);
    expect(
      await screen.findByText("La placa está en la zona horaria UTC; los horarios de los permisos se aplican en esa zona."),
    ).toBeInTheDocument();
  });

  it("no avisa de zona horaria cuando es America/Mexico_City", async () => {
    mockClock(true);
    render(<ClockBadge />);
    expect(await screen.findByText("America/Mexico_City")).toBeInTheDocument();
    expect(screen.queryByText(/zona horaria/)).toBeNull();
  });
});
