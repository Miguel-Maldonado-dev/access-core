import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HolderForm from "./HolderForm";

// Función simple (no vi.fn) para que las promesas rechazadas queden bajo control de la prueba.
const api = vi.hoisted(() => ({
  calls: [] as unknown[][],
  impl: (): Promise<unknown> => Promise.resolve({ pin: "000000" }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => {
    api.calls.push(args);
    return api.impl();
  },
}));

beforeEach(() => {
  api.calls.length = 0;
  api.impl = () => Promise.resolve({ pin: "000000" });
});

const permissions = [
  { permission_id: 0, name: "Todo el día", output_mask: 15, reader_mask: 15, weekday_mask: 127, start_minute: 0, end_minute: 0, allow_pin: false },
];

describe("HolderForm", () => {
  it("exige el nombre y no envía", async () => {
    const onSubmit = vi.fn();
    render(<HolderForm permissions={permissions} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByText("El nombre es obligatorio.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ofrece Persona y Domicilio", () => {
    render(<HolderForm permissions={permissions} onSubmit={vi.fn()} />);
    const select = screen.getByLabelText("Tipo");
    expect(select).toHaveTextContent("Persona");
    expect(select).toHaveTextContent("Domicilio");
  });

  it("envía tipo y permisos marcados", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<HolderForm permissions={permissions} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Nombre"), "Casa 12");
    await user.selectOptions(screen.getByLabelText("Tipo"), "Domicilio");
    await user.click(screen.getByLabelText(/Todo el día/));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "domicilio", name: "Casa 12", department: "", address: "", notes: "", pin: null, permission_ids: [0],
    });
  });

  it("el PIN solo acepta dígitos, hasta 6, y se envía", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<HolderForm permissions={permissions} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Nombre"), "Ana");
    await user.type(screen.getByLabelText("PIN"), "0a1-2 34567");
    expect(screen.getByLabelText("PIN")).toHaveValue("012345");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ pin: "012345" }));
  });

  it("rechaza un PIN de menos de 4 dígitos", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<HolderForm permissions={permissions} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Nombre"), "Ana");
    await user.type(screen.getByLabelText("PIN"), "123");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByText("El PIN debe tener de 4 a 6 dígitos.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Generar llama al endpoint y llena el campo", async () => {
    api.impl = () => Promise.resolve({ pin: "004217" });
    const user = userEvent.setup();
    render(<HolderForm permissions={permissions} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Generar" }));
    expect(api.calls).toEqual([["/api/holders/generate-pin", { method: "POST" }]]);
    expect(await screen.findByDisplayValue("004217")).not.toHaveClass("pin-masked");
    expect(screen.getByRole("button", { name: "Ocultar PIN" })).toBeInTheDocument();
  });

  it("muestra el error si Generar falla", async () => {
    let reject!: (e: Error) => void;
    api.impl = () => new Promise((_, rej) => (reject = rej));
    const user = userEvent.setup();
    render(<HolderForm permissions={permissions} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Generar" }));
    await act(async () => reject(new Error("Sin conexión")));
    expect(await screen.findByText("Sin conexión")).toBeInTheDocument();
  });

  it("oculta el PIN por defecto y lo muestra con el botón", async () => {
    const user = userEvent.setup();
    const holder = { holder_id: 1, kind: "persona" as const, name: "Ana", department: "", address: "", notes: "", has_pin: true, pin: "1234", permission_ids: [], card_count: 0, control_count: 0 };
    render(<HolderForm holder={holder} permissions={permissions} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText("PIN");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveClass("pin-masked");
    await user.click(screen.getByRole("button", { name: "Mostrar PIN" }));
    expect(screen.getByLabelText("PIN")).not.toHaveClass("pin-masked");
    expect(screen.getByRole("button", { name: "Ocultar PIN" })).toBeInTheDocument();
  });

  it("un PIN vacío se envía como null y quitar el PIN de un titular también", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const holder = { holder_id: 1, kind: "persona" as const, name: "Ana", department: "", address: "", notes: "", has_pin: true, pin: "1234", permission_ids: [], card_count: 0, control_count: 0 };
    render(<HolderForm holder={holder} permissions={permissions} onSubmit={onSubmit} />);
    await user.clear(screen.getByLabelText("PIN"));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ pin: null }));
  });
});
