import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PhonesPage from "./page";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const phones = [{ phone_id: 7, holder_id: 1, holder_name: "Casa 12", number: "5512345678", description: "Mamá" }];
const holders = [{ holder_id: 1, name: "Casa 12" }];
const settings = { enabled: true, mode: "single", output_id: 0, menu_mask: 0, default_output: null, call_limit_per_minute: 3 };

describe("PhonesPage", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith("/api/phones") ? phones : path === "/api/calls/settings" ? settings : holders,
      ),
    );
  });

  it("lista los teléfonos con su titular", async () => {
    render(<PhonesPage />);
    expect(await screen.findByText("5512345678")).toBeInTheDocument();
    expect(screen.getAllByText("Casa 12").length).toBeGreaterThan(0);
    expect(screen.getByText("Mamá")).toBeInTheDocument();
  });

  it("crea un teléfono y recarga", async () => {
    const user = userEvent.setup();
    render(<PhonesPage />);
    await screen.findByText("5512345678");
    await user.click(screen.getByRole("button", { name: "Nuevo teléfono" }));
    await user.type(screen.getByLabelText("Número"), "5598765432");
    await user.selectOptions(screen.getByLabelText("Titular"), "1");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/phones", {
      method: "POST",
      body: JSON.stringify({ holder_id: 1, number: "5598765432", description: "" }),
    });
  });

  it("muestra el error del servidor al guardar", async () => {
    const user = userEvent.setup();
    render(<PhonesPage />);
    await screen.findByText("5512345678");
    await user.click(screen.getByRole("button", { name: "Nuevo teléfono" }));
    await user.type(screen.getByLabelText("Número"), "5512345678");
    await user.selectOptions(screen.getByLabelText("Titular"), "1");
    apiFetch.mockRejectedValueOnce(new Error("El número ya está registrado"));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("El número ya está registrado");
  });

  it("con el módulo desactivado avisa y no deja agregar", async () => {
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith("/api/phones") ? [] : path === "/api/calls/settings" ? { ...settings, enabled: false } : holders,
      ),
    );
    render(<PhonesPage />);
    expect(await screen.findByText(/El módulo de llamadas está desactivado/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nuevo teléfono" })).toBeDisabled();
  });
});
