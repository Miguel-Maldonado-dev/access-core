import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ControlForm from "./ControlForm";

const holders = [
  { holder_id: 1, kind: "domicilio" as const, name: "Amadeo 1260", department: "", address: "", notes: "", pin: null, permission_ids: [], card_count: 0, control_count: 0 },
];

describe("ControlForm", () => {
  it("un control nuevo asigna el botón N a Relay N", () => {
    render(<ControlForm holders={holders} onSubmit={vi.fn()} />);
    for (let n = 1; n <= 4; n++) {
      const select = screen.getByLabelText(`Salida del botón ${n}`) as HTMLSelectElement;
      expect(select).toHaveDisplayValue(`Relay${n}`);
      expect(select).toHaveTextContent("Sin asignar");
    }
  });

  it("envía 4 botones; los vacíos van sin código ni salida", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<ControlForm holders={holders} onSubmit={onSubmit} />);
    await user.selectOptions(screen.getByLabelText("Titular"), "1");
    await user.type(screen.getByLabelText("Código del botón 1"), "10387716");
    await user.type(screen.getByLabelText("Código del botón 2"), "10387714");
    await user.selectOptions(screen.getByLabelText("Salida del botón 2"), "Sin asignar");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledWith({
      holder_id: 1,
      description: "",
      buttons: [
        { rf_code: 10387716, output_id: 0 },
        { rf_code: 10387714, output_id: null },
        { rf_code: null, output_id: null },
        { rf_code: null, output_id: null },
      ],
    });
  });

  it("rechaza un código no numérico", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<ControlForm holders={holders} onSubmit={onSubmit} />);
    await user.selectOptions(screen.getByLabelText("Titular"), "1");
    await user.type(screen.getByLabelText("Código del botón 1"), "abc");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Usa solo números (0 a 4294967295).");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("muestra el error de la API tal cual", () => {
    const error = "El código 10387716 ya está registrado en el control 1 (Amadeo 1260).";
    render(<ControlForm holders={holders} error={error} onSubmit={vi.fn()} />);
    expect(screen.getByText(error)).toBeInTheDocument();
  });
});
