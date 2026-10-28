// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CardsManager from "@/components/access/CardsManager";
import HoldersManager from "@/components/access/HoldersManager";
import type { ActionResult } from "@/lib/actions";
import type { CardRow } from "@/lib/cards";
import type { HolderRow } from "@/lib/holders";

/** Interfaz de titulares y tarjetas: las server actions se sustituyen por funciones de prueba. */
const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const titular = (p: Partial<HolderRow> = {}): HolderRow => ({
  id: "h-1",
  kind: "persona",
  name: "Ana Pérez",
  department: "12B",
  address: "Torre Norte",
  notes: "",
  has_pin: true,
  card_count: 2,
  control_count: 1,
  ...p,
});

function montarTitulares(holders: HolderRow[], { canSeePin = false } = {}) {
  const props = {
    holders,
    canSeePin,
    onSave: vi.fn(async (): Promise<ActionResult<{ id: string }>> => ok({ id: "h-9" })),
    onDelete: vi.fn(async () => ok(undefined)),
    onRevealPin: vi.fn(async () => ok<string | null>("482913")),
  };
  const r = render(<HoldersManager {...props} />);
  return { ...props, container: r.container };
}

describe("HoldersManager", () => {
  it("la lista muestra has_pin como Sí o guion y nunca un PIN", () => {
    const { container } = montarTitulares([titular(), titular({ id: "h-2", name: "Beto", has_pin: false })]);
    const filas = screen.getAllByRole("row").slice(1);
    expect(within(filas[0]).getByText("Sí")).toBeTruthy();
    expect(within(filas[1]).queryByText("Sí")).toBeNull();
    expect(container.innerHTML).not.toContain("482913");
  });

  it("filtra por nombre, departamento o dirección", () => {
    montarTitulares([titular(), titular({ id: "h-2", name: "Beto", department: "3A", address: "Torre Sur" })]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar" }), { target: { value: "torre sur" } });
    expect(screen.queryByText("Ana Pérez")).toBeNull();
    expect(screen.getByText("Beto")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar" }), { target: { value: "zzz" } });
    expect(screen.getByText("Ningún titular coincide con la búsqueda.")).toBeTruthy();
  });

  it("un técnico editando un titular no recibe el PIN: no lo pide ni lo muestra", async () => {
    const { onRevealPin, container } = montarTitulares([titular()], { canSeePin: false });
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    expect(await screen.findByRole("heading", { name: "Editar titular" })).toBeTruthy();
    expect(onRevealPin).not.toHaveBeenCalled();
    expect((screen.getByLabelText("PIN") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Este titular tiene PIN/)).toBeTruthy();
    expect(container.innerHTML).not.toContain("482913");
  });

  it("el admin recibe el PIN actual al editar", async () => {
    const { onRevealPin } = montarTitulares([titular()], { canSeePin: true });
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    await waitFor(() => expect((screen.getByLabelText("PIN") as HTMLInputElement).value).toBe("482913"));
    expect(onRevealPin).toHaveBeenCalledWith("h-1");
  });

  it("el técnico guarda sin tocar el PIN (keep) y puede quitarlo", async () => {
    const { onSave } = montarTitulares([titular()]);
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0] as unknown[])[1]).toMatchObject({ pin: { mode: "keep" }, name: "Ana Pérez" });

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Editar titular" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    fireEvent.click(await screen.findByLabelText("Quitar el PIN"));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect((onSave.mock.calls[1] as unknown[])[1]).toMatchObject({ pin: { mode: "clear" } });
  });

  it("un PIN nuevo se manda como set y uno inválido se rechaza en el formulario", async () => {
    const { onSave } = montarTitulares([]);
    fireEvent.click(screen.getByRole("button", { name: "Nuevo titular" }));
    fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Carla" } });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("El PIN debe tener de 4 a 6 dígitos.");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[1]).toMatchObject({ name: "Carla", pin: { mode: "set", pin: "4821" } });
  });

  it("muestra en español el error del servidor (PIN duplicado) y deja abierto el formulario", async () => {
    const { onSave } = montarTitulares([]);
    onSave.mockResolvedValueOnce(fallo("El PIN ya está asignado a otro titular."));
    fireEvent.click(screen.getByRole("button", { name: "Nuevo titular" }));
    fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Dani" } });
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("El PIN ya está asignado a otro titular.");
    expect(screen.getByRole("heading", { name: "Nuevo titular" })).toBeTruthy();
  });

  it("borrar pide confirmación y avisa que también se borran tarjetas y controles", async () => {
    const { onDelete } = montarTitulares([titular()]);
    fireEvent.click(screen.getByRole("button", { name: /Borrar/ }));
    expect(window.confirm).toHaveBeenCalledWith('¿Borrar "Ana Pérez"? También se borrarán sus 2 tarjetas y 1 control.');
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("h-1"));
    expect(await screen.findByText(/Se borró/)).toBeTruthy();
  });

  it("si no confirma, no borra", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onDelete } = montarTitulares([titular()]);
    fireEvent.click(screen.getByRole("button", { name: /Borrar/ }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

const tarjeta = (p: Partial<CardRow> = {}): CardRow => ({
  id: "c-1",
  card_code: 1001,
  holder_id: "h-1",
  holder_name: "Ana Pérez",
  description: "Llavero",
  ...p,
});

function montarTarjetas(cards: CardRow[]) {
  const props = {
    cards,
    holders: [
      { id: "h-1", name: "Ana Pérez" },
      { id: "h-2", name: "Beto" },
    ],
    onSave: vi.fn(async (): Promise<ActionResult<{ id: string }>> => ok({ id: "c-9" })),
    onDelete: vi.fn(async () => ok(undefined)),
  };
  render(<CardsManager {...props} />);
  return props;
}

describe("CardsManager", () => {
  it("un código duplicado muestra el mensaje en español del servidor", async () => {
    const { onSave } = montarTarjetas([]);
    onSave.mockResolvedValueOnce(fallo("La tarjeta 1001 ya está registrada a Ana Pérez."));
    fireEvent.click(screen.getByRole("button", { name: "Nueva tarjeta" }));
    fireEvent.change(await screen.findByLabelText("Código de tarjeta"), { target: { value: "1001" } });
    fireEvent.change(screen.getByLabelText("Titular"), { target: { value: "h-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("La tarjeta 1001 ya está registrada a Ana Pérez.");
    expect((onSave.mock.calls[0] as unknown[])).toEqual([null, { card_code: 1001, holder_id: "h-2", description: "" }]);
  });

  it("valida el código en decimal y que se elija titular antes de enviar", async () => {
    const { onSave } = montarTarjetas([]);
    fireEvent.click(screen.getByRole("button", { name: "Nueva tarjeta" }));
    fireEvent.change(await screen.findByLabelText("Código de tarjeta"), { target: { value: "0x1F" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Usa solo números (0 a 4294967295).");
    fireEvent.change(screen.getByLabelText("Código de tarjeta"), { target: { value: "4294967295" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Elige un titular.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("filtra por titular y por código, y borra con confirmación", async () => {
    const { onDelete } = montarTarjetas([tarjeta(), tarjeta({ id: "c-2", card_code: 2002, holder_id: "h-2", holder_name: "Beto" })]);
    fireEvent.change(screen.getByLabelText("Filtrar por titular"), { target: { value: "h-2" } });
    expect(screen.queryByText("1001")).toBeNull();
    expect(screen.getByText("2002")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Borrar/ }));
    expect(window.confirm).toHaveBeenCalledWith('¿Borrar la tarjeta 2002 de "Beto"?');
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("c-2"));
  });

  it("al editar el código queda de solo lectura", async () => {
    const { onSave } = montarTarjetas([tarjeta()]);
    fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
    const codigo = (await screen.findByLabelText("Código de tarjeta")) as HTMLInputElement;
    expect(codigo.readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[0]).toBe("c-1");
  });
});
