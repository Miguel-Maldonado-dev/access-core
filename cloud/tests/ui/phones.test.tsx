// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CallSettingsManager from "@/components/access/CallSettingsManager";
import PhoneForm from "@/components/access/PhoneForm";
import PhonesManager from "@/components/access/PhonesManager";
import type { ActionResult } from "@/lib/actions";
import type { CallSettingsInput, CallSettingsRow } from "@/lib/call-view";
import type { OutputRow } from "@/lib/outputs";
import type { PhoneRow } from "@/lib/phones";

const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HOLDERS = [
  { id: "h-1", name: "Ana Pérez" },
  { id: "h-2", name: "Luis Gómez" },
];
const telefono = (p: Partial<PhoneRow> = {}): PhoneRow => ({
  id: "t-1",
  holder_id: "h-1",
  holder_name: "Ana Pérez",
  number: "5512345678",
  description: "Celular",
  ...p,
});

describe("PhoneForm", () => {
  it("exige 10 dígitos y no llama a onSubmit", () => {
    const onSubmit = vi.fn();
    render(<PhoneForm holders={HOLDERS} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Número de teléfono"), { target: { value: "123" } });
    fireEvent.change(screen.getByLabelText("Titular"), { target: { value: "h-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert").textContent).toBe("El número debe tener 10 dígitos.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("quita espacios y guiones y envía los 10 dígitos", () => {
    const onSubmit = vi.fn();
    render(<PhoneForm holders={HOLDERS} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Número de teléfono"), { target: { value: "55 1234-5678" } });
    fireEvent.change(screen.getByLabelText("Titular"), { target: { value: "h-2" } });
    fireEvent.change(screen.getByLabelText("Descripción"), { target: { value: "  Casa " } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledWith({ number: "5512345678", holder_id: "h-2", description: "Casa" });
  });

  it("pide elegir titular", () => {
    const onSubmit = vi.fn();
    render(<PhoneForm holders={HOLDERS} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Número de teléfono"), { target: { value: "5512345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert").textContent).toBe("Elige un titular.");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("PhonesManager", () => {
  const lista = [
    telefono(),
    telefono({ id: "t-2", holder_id: "h-2", holder_name: "Luis Gómez", number: "8187654321", description: "" }),
  ];
  const montar = (initialHolder = "", phones = lista) => {
    const props = {
      phones,
      holders: HOLDERS,
      initialHolder,
      onSave: vi.fn(async (): Promise<ActionResult<{ id: string }>> => ok({ id: "t-9" })),
      onDelete: vi.fn(async () => ok(undefined)),
    };
    render(<PhonesManager {...props} />);
    return props;
  };

  it("filtra por número o titular con el buscador", () => {
    montar();
    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "8187" } });
    expect(screen.queryByText("5512345678")).toBeNull();
    expect(screen.getByText("8187654321")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "ana" } });
    expect(screen.getByText("5512345678")).toBeTruthy();
    expect(screen.queryByText("8187654321")).toBeNull();
  });

  it("buscar solo guiones no coincide con todos los números", () => {
    montar();
    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "-" } });
    expect(screen.queryByText("5512345678")).toBeNull();
    expect(screen.queryByText("8187654321")).toBeNull();
    fireEvent.change(screen.getByLabelText("Buscar"), { target: { value: "818-765" } });
    expect(screen.getByText("8187654321")).toBeTruthy();
  });

  it("?holder= preselecciona el filtro por titular", () => {
    montar("h-2");
    expect(screen.queryByText("5512345678")).toBeNull();
    expect(screen.getByText("8187654321")).toBeTruthy();
    expect((screen.getByLabelText("Filtrar por titular") as HTMLSelectElement).value).toBe("h-2");
  });

  it("da de alta un teléfono y avisa", async () => {
    const props = montar();
    fireEvent.click(screen.getByRole("button", { name: "Nuevo teléfono" }));
    fireEvent.change(screen.getByLabelText("Número de teléfono"), { target: { value: "5599998888" } });
    fireEvent.change(screen.getByLabelText("Titular"), { target: { value: "h-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(null, { number: "5599998888", holder_id: "h-1", description: "" }));
    expect((await screen.findByRole("status")).textContent).toContain("5599998888");
  });

  it("muestra el 409 del número repetido dentro del formulario", async () => {
    const props = montar();
    props.onSave.mockResolvedValueOnce(fallo("El número ya está registrado"));
    fireEvent.click(screen.getByRole("button", { name: "Nuevo teléfono" }));
    fireEvent.change(screen.getByLabelText("Número de teléfono"), { target: { value: "5512345678" } });
    fireEvent.change(screen.getByLabelText("Titular"), { target: { value: "h-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("El número ya está registrado");
  });

  it("edita y borra con confirmación", async () => {
    const props = montar();
    fireEvent.click(screen.getByRole("button", { name: /Editar el teléfono 5512345678/ }));
    expect((screen.getByLabelText("Número de teléfono") as HTMLInputElement).value).toBe("5512345678");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: /Borrar el teléfono 5512345678/ }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith("t-1"));
  });

  it("sin teléfonos invita a registrar el primero", () => {
    montar("", []);
    expect(screen.getByText(/Aún no hay teléfonos/)).toBeTruthy();
  });
});

describe("CallSettingsManager", () => {
  const PA = { id: "pa", panel_code: "PNL-AAAA-AAAA" };
  const salidas: OutputRow[] = [0, 1, 2, 3].map((i) => ({
    id: `o${i}`,
    panel_id: "pa",
    output_index: i,
    alias: i === 1 ? "Pluma" : "",
    duration_ms: 3000,
    reader_mask: 1,
    enabled: true,
  }));
  const config = (p: Partial<CallSettingsRow> = {}): CallSettingsRow => ({
    id: "c-1",
    panel_id: "pa",
    enabled: true,
    mode: "single",
    output_index: 0,
    menu_mask: 0b0011,
    default_output: null,
    call_limit_per_minute: 3,
    ...p,
  });
  const montar = (settings: CallSettingsRow[], canEdit = true) => {
    const onSave = vi.fn<(id: string, input: CallSettingsInput) => Promise<ActionResult>>(async () => ok(undefined));
    render(<CallSettingsManager panels={[PA]} settings={settings} outputs={salidas} canEdit={canEdit} onSave={onSave} />);
    return { onSave, form: screen.getByRole("form", { name: "Llamadas de PNL-AAAA-AAAA" }) };
  };

  it("«Una salida» oculta las salidas del menú y la predeterminada", () => {
    const { form } = montar([config()]);
    expect(within(form).getByLabelText("Salida que abre")).toBeTruthy();
    expect(within(form).queryByText("Salidas del menú")).toBeNull();
    expect(within(form).queryByLabelText("Salida predeterminada")).toBeNull();
    fireEvent.click(within(form).getByRole("radio", { name: /Varias salidas/ }));
    expect(within(form).getByText("Salidas del menú")).toBeTruthy();
    expect(within(form).queryByLabelText("Salida que abre")).toBeNull();
  });

  it("muestra el alias de la salida y el límite por omisión", () => {
    const { form } = montar([config()]);
    expect(within(form).getByRole("option", { name: "S2 · Pluma" })).toBeTruthy();
    expect((within(form).getByLabelText("Aperturas por minuto por número") as HTMLInputElement).value).toBe("3");
  });

  it("el técnico lo ve en solo lectura: campos deshabilitados y sin Guardar", () => {
    const { form } = montar([config()], false);
    expect(within(form).getByLabelText("Activar módulo").matches(":disabled")).toBe(true);
    expect(within(form).getByLabelText("Aperturas por minuto por número").matches(":disabled")).toBe(true);
    expect(within(form).queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(screen.getByText(/Solo un administrador/)).toBeTruthy();
  });

  it("guarda modo menú con salidas y predeterminada; quitar una salida limpia la predeterminada", async () => {
    const { form, onSave } = montar([config({ menu_mask: 0b0011, default_output: 1, mode: "menu" })]);
    fireEvent.click(within(form).getByLabelText("S2 · Pluma en el menú"));
    expect((within(form).getByLabelText("Salida predeterminada") as HTMLSelectElement).value).toBe("");
    fireEvent.click(within(form).getByLabelText("S3 en el menú"));
    fireEvent.change(within(form).getByLabelText("Salida predeterminada"), { target: { value: "2" } });
    fireEvent.change(within(form).getByLabelText("Aperturas por minuto por número"), { target: { value: "5" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("c-1", {
        enabled: true,
        mode: "menu",
        output_index: 0,
        menu_mask: 0b0101,
        default_output: 2,
        call_limit_per_minute: 5,
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("PNL-AAAA-AAAA");
  });

  it("rechaza un límite fuera de 1–20 sin llamar a onSave", () => {
    const { form, onSave } = montar([config()]);
    fireEvent.change(within(form).getByLabelText("Aperturas por minuto por número"), { target: { value: "25" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert").textContent).toContain("1 a 20");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("desactivar el módulo pide confirmación porque el panel borrará sus teléfonos", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { form, onSave } = montar([config()]);
    fireEvent.click(within(form).getByLabelText("Activar módulo"));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    expect(confirmar).toHaveBeenCalledWith(expect.stringContaining("borrará sus teléfonos"));
    expect(onSave).not.toHaveBeenCalled();
    confirmar.mockReturnValue(true);
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("c-1", expect.objectContaining({ enabled: false })));
  });

  it("activar el módulo no pide confirmación", async () => {
    const confirmar = vi.spyOn(window, "confirm");
    const { form, onSave } = montar([config({ enabled: false })]);
    fireEvent.click(within(form).getByLabelText("Activar módulo"));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(confirmar).not.toHaveBeenCalled();
  });

  it("muestra el error del servidor", async () => {
    const { form, onSave } = montar([config()]);
    onSave.mockResolvedValueOnce(fallo("Sin permiso", 403));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sin permiso");
  });

  it("un panel sin configuración lo explica", () => {
    render(<CallSettingsManager panels={[PA]} settings={[]} outputs={salidas} canEdit onSave={vi.fn()} />);
    expect(screen.getByText(/aún no tiene configuración de llamadas/)).toBeTruthy();
  });
});
