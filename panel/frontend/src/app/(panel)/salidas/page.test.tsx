import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OutputsPage from "./page";

const outputs = vi.hoisted(() => [
  { output_id: 0, duration_ms: 3000, reader_mask: 3, enabled: true, alias: "Pluma vehicular" },
  { output_id: 1, duration_ms: 3000, reader_mask: 12, enabled: true, alias: "" },
]);
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

describe("OutputsPage", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(outputs);
  });

  it("muestra el alias de cada salida", async () => {
    render(<OutputsPage />);
    const form = await screen.findByRole("form", { name: "Relay1" });
    expect(form).toHaveTextContent("Pluma vehicular");
    expect(screen.getAllByLabelText("Alias").map((i) => (i as HTMLInputElement).value)).toEqual(["Pluma vehicular", ""]);
  });

  it("Probar pide la prueba de esa salida y muestra Salida activada", async () => {
    const user = userEvent.setup();
    render(<OutputsPage />);
    apiFetch.mockResolvedValueOnce({ detail: "Salida activada" });
    await user.click(await screen.findByRole("button", { name: "Probar Relay2" }));
    expect(apiFetch).toHaveBeenLastCalledWith("/api/outputs/1/test", { method: "POST" });
    expect(await screen.findByRole("status")).toHaveTextContent("Salida activada");
  });

  it("Probar muestra el error del servidor", async () => {
    const user = userEvent.setup();
    render(<OutputsPage />);
    apiFetch.mockRejectedValueOnce(new Error("El daemon no responde"));
    await user.click(await screen.findByRole("button", { name: "Probar Relay1" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("El daemon no responde");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
