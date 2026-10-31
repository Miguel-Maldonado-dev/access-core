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

const P1 = "p-1";
const P2 = "p-2";
const PANELES = [
  { id: P1, panel_code: "PNL-AAAA-0001", aliases: ["Pluma vehicular", null, null, "Peatonal"] },
  { id: P2, panel_code: "PNL-BBBB-0002", aliases: [null, null, null, null] },
];

const control = (p: Partial<ControlRow> = {}): ControlRow => ({
  id: "k-1",
  holder_id: "h-1",
  holder_name: "Ana Pérez",
  description: "Llavero",
  buttons: [
    { id: "b-1", button: 0, rf_code: 2001, outputs: { [P1]: 0 } },
    { id: "b-3", button: 2, rf_code: 2003, outputs: { [P1]: 1, [P2]: 3 } },
  ],
  ...p,
});

function montar(controls: ControlRow[], panels = PANELES) {
  const props = {
    controls,
    holders: [
      { id: "h-1", name: "Ana Pérez" },
      { id: "h-2", name: "Beto" },
    ],
    panels,
    onSave: vi.fn(async (): Promise<ActionResult<{ id: string }>> => ok({ id: "k-9" })),
    onDelete: vi.fn(async () => ok(undefined)),
  };
  render(<ControlsManager {...props} />);
  return props;
}

async function nuevo(titular = "h-2") {
  fireEvent.click(screen.getByRole("button", { name: "Nuevo control" }));
  fireEvent.change(await screen.findByLabelText("Titular", { selector: "select" }), { target: { value: titular } });
}

const guardar = () => fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

describe("ControlsManager", () => {
  it("lista cada botón con su código en decimal y su salida en cada panel", () => {
    montar([control()]);
    const fila = screen.getAllByRole("row")[1];
    expect(within(fila).getByText("Botón 1: 2001 → PNL-AAAA-0001 S1, PNL-BBBB-0002 —")).toBeTruthy();
    expect(within(fila).getByText("Botón 3: 2003 → PNL-AAAA-0001 S2, PNL-BBBB-0002 S4")).toBeTruthy();
  });

  it("el formulario muestra un selector por panel con el alias de cada salida", async () => {
    montar([]);
    await nuevo();
    const sel = screen.getByLabelText("Salida del botón 1 en PNL-AAAA-0001") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual([
      "Ninguna",
      "S1 · Pluma vehicular",
      "S2",
      "S3",
      "S4 · Peatonal",
    ]);
    expect(screen.getByLabelText("Salida del botón 1 en PNL-BBBB-0002")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "PNL-BBBB-0002" })).toBeTruthy();
  });

  it("al crear arma outputs con cada panel; los botones sin código se ignoran", async () => {
    const { onSave } = montar([]);
    await nuevo();
    // con varios paneles, una fila nueva empieza en Ninguna en todos
    expect((screen.getByLabelText("Salida del botón 1 en PNL-AAAA-0001") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Código del botón 1"), { target: { value: "3001" } });
    fireEvent.change(screen.getByLabelText("Salida del botón 1 en PNL-AAAA-0001"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Salida del botón 1 en PNL-BBBB-0002"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Código del botón 4"), { target: { value: "3004" } });
    fireEvent.change(screen.getByLabelText("Salida del botón 4 en PNL-AAAA-0001"), { target: { value: "3" } });
    guardar();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]).toEqual([
      null,
      {
        holder_id: "h-2",
        description: "",
        buttons: [
          { id: null, button: 0, rf_code: 3001, outputs: { [P1]: 0, [P2]: 0 } },
          { id: null, button: 3, rf_code: 3004, outputs: { [P1]: 3, [P2]: null } },
        ],
      },
    ]);
  });

  it("con un solo panel, una fila nueva propone la salida del botón", async () => {
    const { onSave } = montar([], [PANELES[0]]);
    await nuevo();
    fireEvent.change(screen.getByLabelText("Código del botón 3"), { target: { value: "3003" } });
    guardar();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[1]).toMatchObject({
      buttons: [{ id: null, button: 2, rf_code: 3003, outputs: { [P1]: 2 } }],
    });
  });

  it("un botón nuevo sin salida en ningún panel no se envía", async () => {
    const { onSave } = montar([]);
    await nuevo();
    fireEvent.change(screen.getByLabelText("Código del botón 2"), { target: { value: "3002" } });
    guardar();
    expect((await screen.findByRole("alert")).textContent).toBe("Botón 2: elige su salida en al menos un panel.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("quitar todas las salidas de un botón pide confirmación antes de borrarlo", async () => {
    const { onSave } = montar([control()]);
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    fireEvent.change(await screen.findByLabelText("Salida del botón 3 en PNL-AAAA-0001"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Salida del botón 3 en PNL-BBBB-0002"), { target: { value: "" } });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    guardar();
    expect(window.confirm).toHaveBeenCalledWith("El botón 3 no tiene salida en ningún panel y se borrará. ¿Continuar?");
    expect(onSave).not.toHaveBeenCalled();
    guardar();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]).toEqual([
      "k-1",
      {
        holder_id: "h-1",
        description: "Llavero",
        buttons: [
          { id: "b-1", button: 0, rf_code: 2001, outputs: { [P1]: 0, [P2]: null } },
          { id: "b-3", button: 2, rf_code: 2003, outputs: { [P1]: null, [P2]: null } },
        ],
      },
    ]);
  });

  it("muestra una fila por botón vivo, aunque compartan número, y filas vacías para los números libres", async () => {
    montar([
      control({
        buttons: [
          { id: "b-1", button: 0, rf_code: 2001, outputs: { [P1]: 0 } },
          { id: "b-1b", button: 0, rf_code: 2011, outputs: { [P2]: 1 } },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    expect(((await screen.findByLabelText("Código del botón 1")) as HTMLInputElement).value).toBe("2001");
    expect((screen.getByLabelText("Código del botón 1 (2)") as HTMLInputElement).value).toBe("2011");
    expect((screen.getByLabelText("Salida del botón 1 (2) en PNL-BBBB-0002") as HTMLSelectElement).value).toBe("1");
    for (const n of [2, 3, 4]) expect((screen.getByLabelText(`Código del botón ${n}`) as HTMLInputElement).value).toBe("");
  });

  it("Sin salida solo se ofrece donde el vínculo ya existe sin salida y se conserva al guardar", async () => {
    const { onSave } = montar([control({ buttons: [{ id: "b-1", button: 0, rf_code: 2001, outputs: { [P1]: 0, [P2]: null } }] })]);
    expect(screen.getByText("Botón 1: 2001 → PNL-AAAA-0001 S1, PNL-BBBB-0002 sin salida")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    const p2 = (await screen.findByLabelText("Salida del botón 1 en PNL-BBBB-0002")) as HTMLSelectElement;
    expect(p2.value).toBe("sin_salida");
    expect([...p2.options].map((o) => o.textContent)).toContain("Sin salida");
    const p1 = screen.getByLabelText("Salida del botón 1 en PNL-AAAA-0001") as HTMLSelectElement;
    expect([...p1.options].map((o) => o.textContent)).not.toContain("Sin salida");
    // quitar la salida del Panel 1 deja el vínculo sin salida: no se borra el botón
    fireEvent.change(p1, { target: { value: "" } });
    guardar();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(window.confirm).not.toHaveBeenCalled();
    expect((onSave.mock.calls[0] as unknown[])[1]).toMatchObject({
      buttons: [{ id: "b-1", button: 0, rf_code: 2001, outputs: { [P1]: null, [P2]: "sin_salida" } }],
    });
  });

  it("sin paneles vinculados pide vincular uno", async () => {
    montar([], []);
    await nuevo();
    expect(screen.getByText("Vincula un panel para asignar salidas a los botones.")).toBeTruthy();
    expect(screen.queryByLabelText("Código del botón 1")).toBeNull();
  });

  it("un RF duplicado muestra el mensaje en español del servidor", async () => {
    const { onSave } = montar([]);
    onSave.mockResolvedValueOnce(fallo("El código 3001 ya está registrado en un control de Ana Pérez."));
    await nuevo();
    fireEvent.change(screen.getByLabelText("Código del botón 1"), { target: { value: "3001" } });
    fireEvent.change(screen.getByLabelText("Salida del botón 1 en PNL-AAAA-0001"), { target: { value: "0" } });
    guardar();
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
    guardar();
    expect((await screen.findByRole("alert")).textContent).toBe("Botón 2: Usa solo números (0 a 4294967295).");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("al editar precarga los botones y filtra por titular; borra con confirmación", async () => {
    const { onSave, onDelete } = montar([control(), control({ id: "k-2", holder_id: "h-2", holder_name: "Beto", buttons: [] })]);
    fireEvent.change(screen.getByLabelText("Filtrar por titular"), { target: { value: "h-1" } });
    expect(screen.queryByRole("rowheader", { name: "Beto" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    expect(((await screen.findByLabelText("Código del botón 3")) as HTMLInputElement).value).toBe("2003");
    expect((screen.getByLabelText("Salida del botón 3 en PNL-BBBB-0002") as HTMLSelectElement).value).toBe("3");
    guardar();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[0]).toBe("k-1");
    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Editar control" })).toBeNull());
    // El formulario se cierra en cuanto onSave responde, pero la transición (`pendiente`) termina
    // en un render posterior y mientras tanto Borrar está deshabilitado: un clic ahí no hace nada.
    const borrar = screen.getByRole("button", { name: /Borrar/ }) as HTMLButtonElement;
    await waitFor(() => expect(borrar.disabled).toBe(false));
    fireEvent.click(borrar);
    expect(window.confirm).toHaveBeenCalledWith('¿Borrar el control de "Ana Pérez"?');
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("k-1"));
  });
});
