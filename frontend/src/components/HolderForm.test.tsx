import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HolderForm from "./HolderForm";

const permissions = [
  { permission_id: 0, name: "Todo el día", output_mask: 15, reader_mask: 15, weekday_mask: 127, start_minute: 0, end_minute: 0 },
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
      kind: "domicilio", name: "Casa 12", department: "", address: "", notes: "", permission_ids: [0],
    });
  });
});
