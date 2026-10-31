import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OutputForm from "./OutputForm";

const output = { output_id: 0, duration_ms: 3000, reader_mask: 3, enabled: true, alias: "Pluma vehicular" };

describe("OutputForm", () => {
  it("muestra el alias guardado junto al nombre de la salida", () => {
    render(<OutputForm output={output} onSubmit={vi.fn()} onTest={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /Relay1/ })).toHaveTextContent("Pluma vehicular");
    expect(screen.getByLabelText("Alias")).toHaveValue("Pluma vehicular");
  });

  it("sin alias muestra solo el nombre de la salida", () => {
    render(<OutputForm output={{ ...output, alias: "" }} onSubmit={vi.fn()} onTest={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Relay1" })).toBeInTheDocument();
    expect(screen.getByLabelText("Alias")).toHaveValue("");
  });

  it("envía el alias editado con el resto de la salida", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<OutputForm output={{ ...output, alias: "" }} onSubmit={onSubmit} onTest={vi.fn()} />);
    await user.type(screen.getByLabelText("Alias"), "Portón peatonal");
    await user.click(screen.getByRole("button", { name: "Guardar Relay1" }));
    expect(onSubmit).toHaveBeenCalledWith({
      duration_ms: 3000,
      reader_mask: 3,
      enabled: true,
      alias: "Portón peatonal",
    });
  });

  it("el alias no pasa de 40 caracteres", () => {
    render(<OutputForm output={output} onSubmit={vi.fn()} onTest={vi.fn()} />);
    expect(screen.getByLabelText("Alias")).toHaveAttribute("maxlength", "40");
  });

  it("Probar llama a onTest sin enviar el formulario y dice Probando… mientras espera", async () => {
    const onSubmit = vi.fn();
    let finish: () => void = () => {};
    const onTest = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<OutputForm output={output} onSubmit={onSubmit} onTest={onTest} />);
    await user.click(screen.getByRole("button", { name: "Probar Relay1" }));
    expect(onTest).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    // El nombre accesible no cambia mientras prueba: lo anuncia aria-busy y el texto visible.
    const busy = screen.getByRole("button", { name: "Probar Relay1" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveTextContent("Probando…");
    finish();
    await waitFor(() => expect(busy).toBeEnabled());
    expect(busy).toHaveAttribute("aria-busy", "false");
    expect(busy).toHaveTextContent("Probar Relay1");
  });
});
