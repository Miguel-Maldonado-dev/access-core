// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OutputsManager from "@/components/access/OutputsManager";
import ProfilesManager from "@/components/access/ProfilesManager";
import type { ActionResult } from "@/lib/actions";
import type { OutputRow } from "@/lib/outputs";
import type { RuleRow } from "@/lib/profile-view";
import type { ProfileRow } from "@/lib/profiles";

const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PA = { id: "pa", panel_code: "PNL-AAAA-AAAA" };
const PB = { id: "pb", panel_code: "PNL-BBBB-BBBB" };

const salida = (panel: string, i: number, p: Partial<OutputRow> = {}): OutputRow => ({
  id: `${panel}-o${i}`,
  panel_id: panel,
  output_index: i,
  alias: "",
  duration_ms: 3000,
  reader_mask: 1,
  enabled: true,
  ...p,
});

const regla = (p: Partial<RuleRow> = {}): RuleRow => ({
  id: "r-1",
  profile_id: "p-1",
  panel_id: "pa",
  output_mask: 0b0101,
  card_reader_mask: 0b0001,
  pin_reader_mask: 0b0010,
  allow_rf: true,
  weekday_mask: 0b0011111,
  start_minute: 8 * 60,
  end_minute: 18 * 60 + 30,
  ...p,
});

const perfil = (p: Partial<ProfileRow> = {}): ProfileRow => ({
  id: "p-1",
  name: "Residente",
  local_permission_id: 0,
  holder_ids: ["h-1"],
  rules: [regla()],
  ...p,
});

function montar(profiles: ProfileRow[], extra: { panels?: typeof PA[]; outputs?: OutputRow[] } = {}) {
  const props = {
    profiles,
    holders: [
      { id: "h-1", name: "Ana Pérez" },
      { id: "h-2", name: "Beto" },
      { id: "h-3", name: "Carla" },
    ],
    panels: extra.panels ?? [PA, PB],
    outputs: extra.outputs ?? [salida("pa", 0, { alias: "Pluma vehicular" }), salida("pa", 1), salida("pb", 0, { alias: "Puerta peatonal" })],
    onCreate: vi.fn(async (): Promise<ActionResult<{ id: string }>> => ok({ id: "p-9" })),
    onRename: vi.fn(async () => ok(undefined)),
    onDelete: vi.fn(async () => ok(undefined)),
    onSaveRules: vi.fn(async () => ok(undefined)),
    onSetHolders: vi.fn(async () => ok(undefined)),
  };
  render(<ProfilesManager {...props} />);
  return props;
}

const editar = () => fireEvent.click(screen.getByRole("button", { name: /Editar/ }));

describe("ProfilesManager", () => {
  it("lista número, nombre, titulares y paneles con regla", () => {
    montar([perfil()]);
    const fila = screen.getAllByRole("row")[1];
    expect(within(fila).getByText("Residente")).toBeTruthy();
    expect(within(fila).getByText("1 de 2")).toBeTruthy();
  });

  it("crea un perfil y abre su edición", async () => {
    const { onCreate } = montar([]);
    fireEvent.click(screen.getByRole("button", { name: "Nuevo perfil" }));
    fireEvent.click(await screen.findByRole("button", { name: "Crear perfil" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Escribe el nombre del perfil.");
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Nombre del perfil"), { target: { value: " Servicio " } });
    fireEvent.click(screen.getByRole("button", { name: "Crear perfil" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Servicio"));
  });

  it("muestra el error del servidor al crear (perfil 33)", async () => {
    const { onCreate } = montar([]);
    onCreate.mockResolvedValueOnce(fallo("Máximo 32 perfiles por instalación."));
    fireEvent.click(screen.getByRole("button", { name: "Nuevo perfil" }));
    fireEvent.change(await screen.findByLabelText("Nombre del perfil"), { target: { value: "Sobra" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear perfil" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Máximo 32 perfiles por instalación.");
  });

  it("con 32 perfiles el botón Nuevo perfil se deshabilita", () => {
    const treinta2 = Array.from({ length: 32 }, (_, i) => perfil({ id: `p-${i}`, name: `P${i}`, local_permission_id: i, rules: [] }));
    montar(treinta2);
    expect((screen.getByRole("button", { name: "Nuevo perfil" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("borra con confirmación que avisa de reglas y titulares", async () => {
    const { onDelete } = montar([perfil()]);
    fireEvent.click(screen.getByRole("button", { name: /Borrar/ }));
    expect(window.confirm).toHaveBeenCalledWith('¿Borrar el perfil "Residente"? Se borrarán también sus reglas. Lo perderán 1 titular.');
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("p-1"));
  });

  it("renombra desde la edición", async () => {
    const { onRename } = montar([perfil()]);
    editar();
    fireEvent.change(await screen.findByLabelText("Nombre del perfil"), { target: { value: "Residentes" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar nombre" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("p-1", "Residentes"));
  });

  describe("editor de reglas", () => {
    it("una columna por panel, con S1–S4 y el alias como texto emergente", async () => {
      montar([perfil()]);
      editar();
      const colA = await screen.findByRole("region", { name: "Regla en PNL-AAAA-AAAA" });
      const s1 = within(colA).getByLabelText(/^S1 \(Pluma vehicular\) en/);
      expect(s1.closest("label")!.getAttribute("title")).toBe("Pluma vehicular");
      expect(within(colA).getByLabelText(/^S2 en/).closest("label")!.hasAttribute("title")).toBe(false);
      expect((s1 as HTMLInputElement).checked).toBe(true);
      expect((within(colA).getByLabelText("S2 en PNL-AAAA-AAAA") as HTMLInputElement).checked).toBe(false);
      expect((within(colA).getByLabelText("S3 en PNL-AAAA-AAAA") as HTMLInputElement).checked).toBe(true);
      // Panel B sin regla.
      const colB = screen.getByRole("region", { name: "Regla en PNL-BBBB-BBBB" });
      expect(within(colB).getByText("Sin acceso en este panel.")).toBeTruthy();
      expect(within(colB).queryByLabelText(/^S1/)).toBeNull();
    });

    it("precarga la regla y manda máscaras, días (lunes = bit 0) y minutos", async () => {
      const { onSaveRules } = montar([perfil()]);
      editar();
      const colA = await screen.findByRole("region", { name: "Regla en PNL-AAAA-AAAA" });
      expect((within(colA).getByLabelText("Tarjeta L1 en PNL-AAAA-AAAA") as HTMLInputElement).checked).toBe(true);
      expect((within(colA).getByLabelText("PIN L2 en PNL-AAAA-AAAA") as HTMLInputElement).checked).toBe(true);
      expect((within(colA).getByLabelText("Desde en PNL-AAAA-AAAA") as HTMLInputElement).value).toBe("08:00");
      expect((within(colA).getByLabelText("Hasta en PNL-AAAA-AAAA") as HTMLInputElement).value).toBe("18:30");
      expect((within(colA).getByLabelText("Sáb en PNL-AAAA-AAAA") as HTMLInputElement).checked).toBe(false);
      fireEvent.click(within(colA).getByLabelText("Sáb en PNL-AAAA-AAAA"));
      fireEvent.click(within(colA).getByLabelText("Tarjeta L4 en PNL-AAAA-AAAA"));
      fireEvent.click(within(colA).getByLabelText("Permitir control RF en PNL-AAAA-AAAA"));
      fireEvent.change(within(colA).getByLabelText("Hasta en PNL-AAAA-AAAA"), { target: { value: "20:15" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar reglas" }));
      await waitFor(() => expect(onSaveRules).toHaveBeenCalled());
      expect(onSaveRules.mock.calls[0]).toEqual([
        "p-1",
        [
          {
            panel_id: "pa",
            rule: {
              output_mask: 0b0101,
              card_reader_mask: 0b1001,
              pin_reader_mask: 0b0010,
              allow_rf: false,
              weekday_mask: 0b0111111,
              start_minute: 480,
              end_minute: 20 * 60 + 15,
            },
          },
          { panel_id: "pb", rule: null },
        ],
      ]);
    });

    it("'Sin acceso en este panel' manda la regla en null y 'Dar acceso' la vuelve a abrir con todos los días", async () => {
      const { onSaveRules } = montar([perfil()]);
      editar();
      const colA = await screen.findByRole("region", { name: "Regla en PNL-AAAA-AAAA" });
      fireEvent.click(within(colA).getByRole("button", { name: "Sin acceso en este panel" }));
      const colB = screen.getByRole("region", { name: "Regla en PNL-BBBB-BBBB" });
      fireEvent.click(within(colB).getByRole("button", { name: "Dar acceso en este panel" }));
      fireEvent.click(within(colB).getByLabelText("S2 en PNL-BBBB-BBBB"));
      fireEvent.click(screen.getByRole("button", { name: "Guardar reglas" }));
      await waitFor(() => expect(onSaveRules).toHaveBeenCalled());
      expect(onSaveRules.mock.calls[0]).toEqual([
        "p-1",
        [
          { panel_id: "pa", rule: null },
          {
            panel_id: "pb",
            rule: {
              output_mask: 0b0010,
              card_reader_mask: 0,
              pin_reader_mask: 0,
              allow_rf: false,
              weekday_mask: 127,
              start_minute: 0,
              end_minute: 0,
            },
          },
        ],
      ]);
    });

    it("valida el horario antes de enviar y muestra el error del servidor", async () => {
      const { onSaveRules } = montar([perfil()]);
      editar();
      const colA = await screen.findByRole("region", { name: "Regla en PNL-AAAA-AAAA" });
      fireEvent.change(within(colA).getByLabelText("Desde en PNL-AAAA-AAAA"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar reglas" }));
      expect((await screen.findByRole("alert")).textContent).toBe("PNL-AAAA-AAAA: Horario inválido: usa HH:MM");
      expect(onSaveRules).not.toHaveBeenCalled();
      fireEvent.change(within(colA).getByLabelText("Desde en PNL-AAAA-AAAA"), { target: { value: "07:00" } });
      onSaveRules.mockResolvedValueOnce(fallo("El panel no existe o ya no está vinculado.", 400));
      fireEvent.click(screen.getByRole("button", { name: "Guardar reglas" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("El panel no existe o ya no está vinculado."));
    });

    it("sin paneles explica cómo vincular uno", async () => {
      montar([perfil({ rules: [] })], { panels: [] });
      editar();
      expect((await screen.findAllByText(/aún no tiene paneles/)).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Guardar reglas" })).toBeNull();
    });
  });

  describe("asignación a titulares", () => {
    it("marca los asignados, filtra por texto sin perder la selección y guarda", async () => {
      const { onSetHolders } = montar([perfil()]);
      editar();
      expect((await screen.findByRole("checkbox", { name: "Ana Pérez" }) as HTMLInputElement).checked).toBe(true);
      fireEvent.change(screen.getByLabelText("Buscar titular"), { target: { value: "carl" } });
      expect(screen.queryByRole("checkbox", { name: "Ana Pérez" })).toBeNull();
      fireEvent.click(screen.getByRole("checkbox", { name: "Carla" }));
      fireEvent.change(screen.getByLabelText("Buscar titular"), { target: { value: "zzz" } });
      expect(screen.getByText("Ningún titular coincide con la búsqueda.")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Buscar titular"), { target: { value: "" } });
      expect(screen.getByText("2 titulares seleccionados")).toBeTruthy();
      fireEvent.click(screen.getByRole("checkbox", { name: "Ana Pérez" }));
      fireEvent.click(screen.getByRole("button", { name: "Guardar titulares" }));
      await waitFor(() => expect(onSetHolders).toHaveBeenCalledWith("p-1", ["h-3"]));
      expect(await screen.findByText("Se guardaron los titulares.")).toBeTruthy();
    });
  });
});

describe("OutputsManager", () => {
  function montarSalidas(outputs: OutputRow[], panels = [PA, PB]) {
    const onSave = vi.fn(async (): Promise<ActionResult> => ok(undefined));
    render(<OutputsManager panels={panels} outputs={outputs} onSave={onSave} />);
    return onSave;
  }
  const todas = (panel: string) => [0, 1, 2, 3].map((i) => salida(panel, i));

  it("muestra las 4 salidas por panel como S1–S4 y avisa si un panel aún no tiene", () => {
    montarSalidas([...todas("pa")]);
    for (const n of ["S1", "S2", "S3", "S4"]) expect(screen.getByRole("form", { name: `PNL-AAAA-AAAA ${n}` })).toBeTruthy();
    expect(screen.getByText(/Este panel aún no tiene salidas/)).toBeTruthy();
  });

  it("guarda alias, duración, lectores y habilitada de una salida", async () => {
    const onSave = montarSalidas(todas("pa"));
    const form = screen.getByRole("form", { name: "PNL-AAAA-AAAA S2" });
    fireEvent.change(within(form).getByLabelText("Alias"), { target: { value: " Puerta peatonal " } });
    fireEvent.change(within(form).getByLabelText("Duración del pulso (ms)"), { target: { value: "1500" } });
    fireEvent.click(within(form).getByLabelText("L3"));
    fireEvent.click(within(form).getByLabelText("Habilitada"));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar S2" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]).toEqual(["pa-o1", { alias: "Puerta peatonal", duration_ms: 1500, reader_mask: 0b0101, enabled: false }]);
    expect(await within(form).findByText("Se guardó S2.")).toBeTruthy();
  });

  it("valida la duración y muestra el error del servidor", async () => {
    const onSave = montarSalidas(todas("pa"));
    const form = screen.getByRole("form", { name: "PNL-AAAA-AAAA S1" });
    fireEvent.change(within(form).getByLabelText("Duración del pulso (ms)"), { target: { value: "70000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar S1" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("La duración debe ser un número entero de 0 a 65535 ms.");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText("Duración del pulso (ms)"), { target: { value: "100" } });
    onSave.mockResolvedValueOnce(fallo("La salida no existe.", 404));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar S1" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("La salida no existe.");
  });
});
