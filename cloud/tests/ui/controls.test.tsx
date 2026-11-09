// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ControlsManager from "@/components/access/ControlsManager";
import type { ActionResult } from "@/lib/actions";
import type { ControlRow } from "@/lib/controls";
import type { ListenRfStatus } from "@/lib/panel-commands";

const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const P1 = "p-1";
const P2 = "p-2";
const PANELES = [
  { id: P1, panel_code: "PNL-AAAA-0001", aliases: ["Pluma vehicular", null, null, "Peatonal"], active: true },
  { id: P2, panel_code: "PNL-BBBB-0002", aliases: [null, null, null, null], active: true },
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

describe("ControlForm: Escuchar", () => {
  const avanzar = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const estado = (p: Partial<ListenRfStatus>): ActionResult<ListenRfStatus> =>
    ok({ status: "pending", code: null, control: null, detail: null, ...p });

  function abrirEscucha(panels = PANELES, controlEditado?: ControlRow) {
    vi.useFakeTimers();
    const onListen = vi.fn<(panelId: string) => Promise<ActionResult<{ commandId: string }>>>(async () => ok({ commandId: "c-1" }));
    const onListenStatus = vi.fn<(id: string) => Promise<ActionResult<ListenRfStatus>>>(async () => estado({}));
    const controls = controlEditado ? [controlEditado] : [];
    render(
      <ControlsManager
        controls={controls}
        holders={[{ id: "h-1", name: "Ana Pérez" }]}
        panels={panels}
        onSave={vi.fn(async () => ok({ id: "k-9" }))}
        onDelete={vi.fn(async () => ok(undefined))}
        onListen={onListen}
        onListenStatus={onListenStatus}
      />,
    );
    fireEvent.click(controlEditado ? screen.getByRole("button", { name: /Editar/ }) : screen.getByRole("button", { name: "Nuevo control" }));
    return { onListen, onListenStatus };
  }
  const escuchar = (n = 1) => fireEvent.click(screen.getByRole("button", { name: `Escuchar el código del botón ${n}` }));
  const codigo = (n = 1) => (screen.getByLabelText(`Código del botón ${n}`) as HTMLInputElement).value;

  it("con 2 paneles activos muestra el selector; con 1 no; los inactivos no se ofrecen", () => {
    abrirEscucha();
    const sel = screen.getByLabelText("Panel que escucha") as HTMLSelectElement;
    expect(sel.options).toHaveLength(2);
    cleanup();
    abrirEscucha([PANELES[0], { ...PANELES[1], active: false }]);
    expect(screen.queryByLabelText("Panel que escucha")).toBeNull();
  });

  it("sin paneles activos explica por qué no se puede escuchar", () => {
    abrirEscucha(PANELES.map((p) => ({ ...p, active: false })));
    expect(screen.queryByRole("button", { name: /Escuchar el código/ })).toBeNull();
    expect(screen.getByText("Escuchar requiere un panel activo.")).toBeTruthy();
  });

  it("Escuchar pide al panel elegido, consulta cada 1 s y escribe el código", async () => {
    const { onListen, onListenStatus } = abrirEscucha();
    fireEvent.change(screen.getByLabelText("Panel que escucha"), { target: { value: P2 } });
    escuchar();
    await avanzar(0);
    expect(onListen).toHaveBeenCalledWith(P2);
    expect(screen.getByRole("button", { name: "Escuchando…" })).toBeTruthy();
    await avanzar(999);
    expect(onListenStatus).not.toHaveBeenCalled();
    await avanzar(1);
    expect(onListenStatus).toHaveBeenCalledWith("c-1");
    onListenStatus.mockResolvedValueOnce(estado({ status: "received", code: 777 }));
    await avanzar(1000);
    expect(codigo()).toBe("777");
    expect(screen.queryByRole("button", { name: "Escuchando…" })).toBeNull();
  });

  it("un código de otro control avisa y no escribe", async () => {
    const { onListenStatus } = abrirEscucha();
    onListenStatus.mockResolvedValue(estado({ status: "received", code: 5, control: { id: "k-2", description: "Llavero de Beto" } }));
    escuchar();
    await avanzar(1000);
    expect(screen.getByText("Este código ya pertenece a Llavero de Beto").className).toContain("text-danger");
    expect(codigo()).toBe("");
  });

  it("sin descripción dice otro control", async () => {
    const { onListenStatus } = abrirEscucha();
    onListenStatus.mockResolvedValue(estado({ status: "received", code: 5, control: { id: "k-2", description: null } }));
    escuchar();
    await avanzar(1000);
    expect(screen.getByText("Este código ya pertenece a otro control")).toBeTruthy();
  });

  it("un código del mismo control que se edita se escribe sin aviso", async () => {
    const { onListenStatus } = abrirEscucha(PANELES, control());
    onListenStatus.mockResolvedValue(estado({ status: "received", code: 2001, control: { id: "k-1", description: "Llavero" } }));
    escuchar(2);
    await avanzar(1000);
    expect(codigo(2)).toBe("2001");
    expect(screen.queryByText(/ya pertenece/)).toBeNull();
  });

  it("con error muestra el detalle del panel", async () => {
    const { onListenStatus } = abrirEscucha();
    onListenStatus.mockResolvedValue(estado({ status: "error", detail: "No se recibió ningún control." }));
    escuchar();
    await avanzar(1000);
    expect(screen.getByText("No se recibió ningún control.")).toBeTruthy();
  });

  it("si a los 20 s sigue pendiente dice que el panel no respondió", async () => {
    const { onListenStatus } = abrirEscucha();
    escuchar();
    await avanzar(19_000);
    expect(screen.queryByText("El panel no respondió.")).toBeNull();
    await avanzar(1000);
    expect(screen.getByText("El panel no respondió.")).toBeTruthy();
    expect(onListenStatus.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it("solo escucha una fila a la vez", async () => {
    const { onListen } = abrirEscucha();
    escuchar(1);
    await avanzar(0);
    expect((screen.getByRole("button", { name: "Escuchar el código del botón 2" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onListen).toHaveBeenCalledTimes(1);
  });

  it("al desmontar cancela el sondeo y no consulta más", async () => {
    const { onListenStatus } = abrirEscucha();
    escuchar();
    await avanzar(1000);
    expect(onListenStatus).toHaveBeenCalledTimes(1);
    cleanup();
    await avanzar(5000);
    expect(onListenStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dos clics seguidos piden una sola escucha", async () => {
    const { onListen } = abrirEscucha();
    const boton = screen.getByRole("button", { name: "Escuchar el código del botón 1" });
    fireEvent.click(boton);
    fireEvent.click(boton);
    await avanzar(0);
    expect(onListen).toHaveBeenCalledTimes(1);
  });

  it("la región de avisos existe siempre en el DOM", () => {
    abrirEscucha();
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});
