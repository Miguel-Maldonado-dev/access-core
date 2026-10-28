import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CloudPage from "./page";
import type { CloudStatus } from "@/lib/types";

const api = vi.hoisted(() => ({ status: null as unknown }));
vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve(api.status) }));

const base: CloudStatus = {
  panel_code: "PNL-7K2M-9QXA",
  claim_code: null,
  state: "active",
  installation_name: "Fraccionamiento Los Pinos",
  last_sync_at: "2026-10-28T18:30:00.000Z",
  cloud_revision: 42,
  pending_changes: 3,
  last_error: null,
};
const REVIEW =
  "La importación está en revisión en la plataforma. Los cambios que hagas aquí mientras tanto se perderán al adoptar los datos de la nube.";

describe("CloudPage", () => {
  beforeEach(() => {
    api.status = base;
  });

  it("muestra el panel_code y oculta el código de vinculación hasta presionar Mostrar", async () => {
    api.status = { ...base, state: "unlinked", claim_code: "H4X9K2MQ", installation_name: null, last_sync_at: null };
    render(<CloudPage />);
    expect(await screen.findByText("PNL-7K2M-9QXA")).toBeInTheDocument();
    expect(screen.queryByText("H4X9K2MQ")).not.toBeInTheDocument();
    expect(screen.getByText("Captura estos dos datos en la plataforma, en Instalación → Paneles → Vincular panel.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mostrar" }));
    expect(screen.getByText("H4X9K2MQ")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));
    expect(screen.queryByText("H4X9K2MQ")).not.toBeInTheDocument();
  });

  it("vinculado: no hay código de vinculación y muestra el resto del estado", async () => {
    api.status = { ...base, last_error: "No se pudo contactar la plataforma." };
    render(<CloudPage />);
    expect(await screen.findByText("Fraccionamiento Los Pinos")).toBeInTheDocument();
    expect(screen.getByText("Vinculado")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("No se pudo contactar la plataforma.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mostrar" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Captura estos dos datos/)).not.toBeInTheDocument();
    expect(screen.queryByText(REVIEW)).not.toBeInTheDocument();
  });

  it.each(["staging", "awaiting_review"] as const)("en %s avisa que la importación está en revisión", async (state) => {
    api.status = { ...base, state };
    render(<CloudPage />);
    expect(await screen.findByText(REVIEW)).toBeInTheDocument();
  });

  it("sin error ni sincronización lo dice", async () => {
    api.status = { ...base, last_sync_at: null };
    render(<CloudPage />);
    await screen.findByText("Fraccionamiento Los Pinos");
    expect(screen.getByText("Sin errores")).toBeInTheDocument();
    expect(screen.getByText("Aún no sincroniza")).toBeInTheDocument();
  });

  it("sin identidad explica que el servicio aún no la genera", async () => {
    api.status = { ...base, panel_code: null, state: "unlinked" };
    render(<CloudPage />);
    expect(await screen.findByText("El servicio de nube aún no ha generado la identidad del panel.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mostrar" })).not.toBeInTheDocument();
  });
});
