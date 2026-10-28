import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OutputForm from "./OutputForm";

const output = { output_id: 0, duration_ms: 3000, reader_mask: 3, enabled: true, alias: "Pluma vehicular" };

describe("OutputForm", () => {
  it("muestra el alias guardado junto al nombre de la salida", () => {
    render(<OutputForm output={output} onSubmit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /Relay1/ })).toHaveTextContent("Pluma vehicular");
    expect(screen.getByLabelText("Alias")).toHaveValue("Pluma vehicular");
  });

  it("sin alias muestra solo el nombre de la salida", () => {
    render(<OutputForm output={{ ...output, alias: "" }} onSubmit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Relay1" })).toBeInTheDocument();
    expect(screen.getByLabelText("Alias")).toHaveValue("");
  });

  it("envía el alias editado con el resto de la salida", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<OutputForm output={{ ...output, alias: "" }} onSubmit={onSubmit} />);
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
    render(<OutputForm output={output} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Alias")).toHaveAttribute("maxlength", "40");
  });
});
