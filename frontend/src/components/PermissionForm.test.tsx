import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PermissionForm from "./PermissionForm";

describe("PermissionForm", () => {
  it("avisa que los controles RF ignoran los lectores", () => {
    render(<PermissionForm onSubmit={vi.fn()} />);
    expect(screen.getByText("Los controles RF ignoran los lectores.")).toBeInTheDocument();
  });

  it("envía las máscaras y el horario", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PermissionForm onSubmit={onSubmit} />);
    await user.clear(screen.getByLabelText("Número"));
    await user.type(screen.getByLabelText("Número"), "3");
    await user.type(screen.getByLabelText("Nombre"), "Oficina");
    await user.click(screen.getByLabelText("Relay1"));
    await user.click(screen.getByLabelText("Relay2"));
    await user.click(screen.getByLabelText("Reader1"));
    await user.click(screen.getByLabelText("Permitir PIN"));
    for (const d of ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"]) {
      await user.click(screen.getByLabelText(d));
    }
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "18:00" } });
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledWith({
      permission_id: 3, name: "Oficina", output_mask: 3, reader_mask: 1,
      weekday_mask: 31, start_minute: 480, end_minute: 1080, allow_pin: true,
    });
  });

  it("Permitir PIN empieza desmarcado y refleja el permiso editado", async () => {
    const { unmount } = render(<PermissionForm onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Permitir PIN")).not.toBeChecked();
    unmount();
    const p = { permission_id: 1, name: "x", output_mask: 1, reader_mask: 1, weekday_mask: 1, start_minute: 0, end_minute: 0, allow_pin: true };
    render(<PermissionForm permission={p} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Permitir PIN")).toBeChecked();
  });
});
