import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PermissionForm from "./PermissionForm";

describe("PermissionForm", () => {
  it("muestra la cuadrícula Tarjeta/PIN por lector y la nota del control RF", () => {
    render(<PermissionForm onSubmit={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: "Tarjeta" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "PIN" })).toBeInTheDocument();
    for (let i = 1; i <= 4; i++) {
      expect(screen.getByLabelText(`Tarjeta Reader${i}`)).not.toBeChecked();
      expect(screen.getByLabelText(`PIN Reader${i}`)).not.toBeChecked();
    }
    expect(screen.getByLabelText("Permitir control RF")).not.toBeChecked();
    expect(
      screen.getByText("El control RF no depende del lector: usa las salidas, días y horario de este permiso."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Permitir PIN")).not.toBeInTheDocument();
    const grid = screen.getByLabelText("PIN Reader4");
    const rf = screen.getByLabelText("Permitir control RF");
    const days = screen.getByLabelText("Lunes");
    expect(grid.compareDocumentPosition(rf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rf.compareDocumentPosition(days) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("envía las máscaras por método, el RF y el horario", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PermissionForm onSubmit={onSubmit} />);
    await user.clear(screen.getByLabelText("Número"));
    await user.type(screen.getByLabelText("Número"), "3");
    await user.type(screen.getByLabelText("Nombre"), "Oficina");
    await user.click(screen.getByLabelText("Relay1"));
    await user.click(screen.getByLabelText("Relay2"));
    await user.click(screen.getByLabelText("Tarjeta Reader1"));
    await user.click(screen.getByLabelText("PIN Reader1"));
    await user.click(screen.getByLabelText("PIN Reader3"));
    await user.click(screen.getByLabelText("Permitir control RF"));
    for (const d of ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"]) {
      await user.click(screen.getByLabelText(d));
    }
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "18:00" } });
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledWith({
      permission_id: 3, name: "Oficina", output_mask: 3, card_reader_mask: 1, pin_reader_mask: 5,
      weekday_mask: 31, start_minute: 480, end_minute: 1080, allow_rf: true,
    });
  });

  it("refleja el permiso editado", () => {
    const p = {
      permission_id: 1, name: "x", output_mask: 1, card_reader_mask: 2, pin_reader_mask: 8,
      weekday_mask: 1, start_minute: 0, end_minute: 0, allow_rf: true,
    };
    render(<PermissionForm permission={p} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Tarjeta Reader2")).toBeChecked();
    expect(screen.getByLabelText("Tarjeta Reader1")).not.toBeChecked();
    expect(screen.getByLabelText("PIN Reader4")).toBeChecked();
    expect(screen.getByLabelText("PIN Reader2")).not.toBeChecked();
    expect(screen.getByLabelText("Permitir control RF")).toBeChecked();
  });
});
