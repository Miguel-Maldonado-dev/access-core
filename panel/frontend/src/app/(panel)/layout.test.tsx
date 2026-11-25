import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import PanelLayout from "./layout";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("next/navigation", () => ({ usePathname: () => "/titulares/" }));
vi.mock("@/components/ClockBadge", () => ({ default: () => null }));

function settings(enabled: boolean) {
  apiFetch.mockResolvedValue({ enabled, mode: "single", output_id: 0, menu_mask: 0, default_output: null, call_limit_per_minute: 3 });
}

describe("PanelLayout", () => {
  beforeEach(() => apiFetch.mockReset());

  it("muestra Llamadas siempre y Teléfonos solo con el módulo activo", async () => {
    settings(true);
    render(<PanelLayout>x</PanelLayout>);
    expect(await screen.findByRole("link", { name: "Teléfonos" })).toHaveAttribute("href", "/telefonos");
    expect(screen.getByRole("link", { name: "Llamadas" })).toHaveAttribute("href", "/llamadas");
  });

  it("oculta Teléfonos con el módulo desactivado", async () => {
    settings(false);
    render(<PanelLayout>x</PanelLayout>);
    expect(screen.getByRole("link", { name: "Llamadas" })).toBeInTheDocument();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/calls/settings"));
    expect(screen.queryByRole("link", { name: "Teléfonos" })).not.toBeInTheDocument();
  });

  it("refresca el menú al guardar en Llamadas", async () => {
    settings(false);
    render(<PanelLayout>x</PanelLayout>);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    settings(true);
    act(() => {
      window.dispatchEvent(new Event("acceso:calls-changed"));
    });
    expect(await screen.findByRole("link", { name: "Teléfonos" })).toBeInTheDocument();
  });

  it("oculta Teléfonos si no se puede consultar la configuración", async () => {
    apiFetch.mockImplementation((path?: string) =>
      path === undefined ? undefined : Promise.reject(new Error("sin respuesta")),
    );
    await act(async () => {
      render(<PanelLayout>x</PanelLayout>);
    });
    expect(screen.queryByRole("link", { name: "Teléfonos" })).not.toBeInTheDocument();
  });
});
