// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ControlsManager from "@/components/access/ControlsManager";
import type { ActionResult } from "@/lib/actions";
import type { ControlRow } from "@/lib/controls";

const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const control = (p: Partial<ControlRow> = {}): ControlRow => ({
  id: "k-1",
  holder_id: "h-1",
  holder_name: "Ana Pérez",
  description: "Llavero",
  buttons: [
    { button: 0, rf_code: 2001, output_index: 0 },
    { button: 2, rf_code: 2003, output_index: null },
  ],
  ...p,
});

function montar(controls: ControlRow[]) {
  const props = {
    controls,
    holders: [
      { id: "h-1", name: "Ana Pérez" },
      { id: "h-2", name: "Beto" },
    ],
    onSave: vi.fn(async (): Promise<ActionResult<{ id: string }>> => ok({ id: "k-9" })),
    onDelete: vi.fn(async () => ok(undefined)),
  };
  render(<ControlsManager {...props} />);
  return props;
}

describe("ControlsManager", () => {
  it("lista los botones con su código en decimal y su salida S1-S4", () => {
    montar([control()]);
    const fila = screen.getAllByRole("row")[1];
    expect(within(fila).getByText(/Botón 1: 2001 → S1/)).toBeTruthy();
    expect(within(fila).getByText(/Botón 3: 2003 → Sin asignar/)).toBeTruthy();
  });

  it("al crear manda 4 botones; los vacíos se ignoran y la salida por omisión es la del botón", async () => {
    const { onSave } = montar([]);
    fireEvent.click(screen.getByRole("button", { name: "Nuevo control" }));
    fireEvent.change(await screen.findByLabelText("Titular", { selector: "select" }), { target: { value: "h-2" } });
    fireEvent.change(screen.getByLabelText("Código del botón 1"), { target: { value: "3001" } });
    fireEvent.change(screen.getByLabelText("Código del botón 4"), { target: { value: "3004" } });
    fireEvent.change(screen.getByLabelText("Salida del botón 4"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]).toEqual([
      null,
      {
        holder_id: "h-2",
        description: "",
        buttons: [
          { rf_code: 3001, output_index: 0 },
          { rf_code: null, output_index: null },
          { rf_code: null, output_index: null },
          { rf_code: 3004, output_index: null },
        ],
      },
    ]);
  });

  it("un RF duplicado muestra el mensaje en español del servidor", async () => {
    const { onSave } = montar([]);
    onSave.mockResolvedValueOnce(fallo("El código 3001 ya está registrado en un control de Ana Pérez."));
    fireEvent.click(screen.getByRole("button", { name: "Nuevo control" }));
    fireEvent.change(await screen.findByLabelText("Titular", { selector: "select" }), { target: { value: "h-2" } });
    fireEvent.change(screen.getByLabelText("Código del botón 1"), { target: { value: "3001" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "El código 3001 ya está registrado en un control de Ana Pérez.",
    );
  });

  it("valida titular y códigos antes de enviar", async () => {
    const { onSave } = montar([]);
    fireEvent.click(screen.getByRole("button", { name: "Nuevo control" }));
    fireEvent.click(await screen.findByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Elige un titular.");
    fireEvent.change(screen.getByLabelText("Titular", { selector: "select" }), { target: { value: "h-1" } });
    fireEvent.change(screen.getByLabelText("Código del botón 2"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Botón 2: Usa solo números (0 a 4294967295).");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("al editar precarga los botones y filtra por titular; borra con confirmación", async () => {
    const { onSave, onDelete } = montar([control(), control({ id: "k-2", holder_id: "h-2", holder_name: "Beto", buttons: [] })]);
    fireEvent.change(screen.getByLabelText("Filtrar por titular"), { target: { value: "h-1" } });
    expect(screen.queryByRole("rowheader", { name: "Beto" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    expect((await screen.findByLabelText("Código del botón 3") as HTMLInputElement).value).toBe("2003");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[0]).toBe("k-1");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Editar control" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Borrar/ }));
    expect(window.confirm).toHaveBeenCalledWith('¿Borrar el control de "Ana Pérez"?');
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("k-1"));
  });
});
