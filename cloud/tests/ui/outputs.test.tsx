// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OutputsManager from "@/components/access/OutputsManager";
import type { ActionResult } from "@/lib/actions";
import type { OutputRow } from "@/lib/outputs";
import type { CommandStatus } from "@/lib/panel-commands";

/**
 * "Probar" una salida desde la nube: las server actions se sustituyen por funciones de
 * prueba y el reloj es falso para recorrer la espera de 8 s del resultado.
 */
const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });
const estado = (status: CommandStatus, detail: string | null = null) => ok({ status, detail });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PA = { id: "pa", panel_code: "PNL-AAAA-AAAA" };
const salidas: OutputRow[] = [0, 1, 2, 3].map((i) => ({
  id: `pa-o${i}`,
  panel_id: "pa",
  output_index: i,
  alias: "",
  duration_ms: 3000,
  reader_mask: 1,
  enabled: true,
}));

/** Avanza el reloj falso y deja correr las promesas pendientes. */
const avanzar = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function montar(
  onStatus = vi.fn<(commandId: string) => Promise<ActionResult<{ status: CommandStatus; detail: string | null }>>>(
    async () => estado("pending"),
  ),
  onTest = vi.fn<(outputId: string) => Promise<ActionResult<{ commandId: string }>>>(async () => ok({ commandId: "cmd-1" })),
) {
  render(
    <OutputsManager
      panels={[PA]}
      outputs={salidas}
      onSave={vi.fn(async (): Promise<ActionResult> => ok(undefined))}
      onTest={onTest}
      onStatus={onStatus}
    />,
  );
  const form = screen.getByRole("form", { name: "PNL-AAAA-AAAA S1" });
  return { form, onTest, onStatus };
}

describe("Probar salida", () => {
  it("«Probar S1» pide la prueba, espera y muestra «Salida activada»", async () => {
    const { form, onTest, onStatus } = montar(vi.fn(async () => estado("ok")));
    fireEvent.click(within(form).getByRole("button", { name: "Probar S1" }));
    await avanzar(0);
    expect(onTest).toHaveBeenCalledWith("pa-o0");
    expect(within(form).getByRole("button", { name: "Probando…" })).toBeTruthy();
    await avanzar(1000);
    expect(onStatus).toHaveBeenCalledWith("cmd-1");
    expect(within(form).getByRole("status").textContent).toBe("Salida activada");
    expect(within(form).getByRole("button", { name: "Probar S1" })).toBeTruthy();
  });

  it("el error del panel se muestra con su detalle", async () => {
    const { form } = montar(vi.fn(async () => estado("error", "Error de UART")));
    fireEvent.click(within(form).getByRole("button", { name: "Probar S1" }));
    await avanzar(1000);
    expect(within(form).getByRole("alert").textContent).toBe("Error de UART");
  });

  it("si sigue pendiente a los 8 s muestra «El panel no respondió»", async () => {
    const { form, onStatus } = montar();
    fireEvent.click(within(form).getByRole("button", { name: "Probar S1" }));
    await avanzar(7000);
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(within(form).getByRole("button", { name: "Probando…" })).toBeTruthy();
    await avanzar(1000);
    expect(within(form).getByRole("alert").textContent).toBe("El panel no respondió");
    expect(onStatus).toHaveBeenCalledTimes(8);
    await avanzar(5000);
    expect(onStatus).toHaveBeenCalledTimes(8);
  });

  it("una orden caducada también dice «El panel no respondió»", async () => {
    const { form } = montar(vi.fn(async () => estado("expired")));
    fireEvent.click(within(form).getByRole("button", { name: "Probar S1" }));
    await avanzar(1000);
    expect(within(form).getByRole("alert").textContent).toBe("El panel no respondió");
  });

  it("si la prueba se rechaza con 409 muestra «Panel sin conexión» y no consulta", async () => {
    const { form, onStatus } = montar(undefined, vi.fn(async () => fallo("Panel sin conexión", 409)));
    fireEvent.click(within(form).getByRole("button", { name: "Probar S1" }));
    await avanzar(0);
    expect(within(form).getByRole("alert").textContent).toBe("Panel sin conexión");
    expect(within(form).getByRole("button", { name: "Probar S1" })).toBeTruthy();
    await avanzar(3000);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("si la acción de prueba lanza (red o base) muestra un error y libera el botón", async () => {
    const { form, onStatus } = montar(
      undefined,
      vi.fn(async (): Promise<ActionResult<{ commandId: string }>> => {
        throw new Error("fetch failed");
      }),
    );
    fireEvent.click(within(form).getByRole("button", { name: "Probar S1" }));
    await avanzar(0);
    expect(within(form).getByRole("alert").textContent).toBe("No se pudo consultar el panel. Intenta de nuevo.");
    expect(within(form).getByRole("button", { name: "Probar S1" })).toBeTruthy();
    await avanzar(3000);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("si la consulta del resultado lanza muestra un error y deja de consultar", async () => {
    const onStatus = vi.fn(async (): Promise<ActionResult<{ status: CommandStatus; detail: string | null }>> => {
      throw new Error("fetch failed");
    });
    const { form } = montar(onStatus);
    fireEvent.click(within(form).getByRole("button", { name: "Probar S1" }));
    await avanzar(1000);
    expect(within(form).getByRole("alert").textContent).toBe("No se pudo consultar el panel. Intenta de nuevo.");
    expect(within(form).getByRole("button", { name: "Probar S1" })).toBeTruthy();
    await avanzar(5000);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("«Probar» no envía el formulario", async () => {
    const onSave = vi.fn(async (): Promise<ActionResult> => ok(undefined));
    render(
      <OutputsManager
        panels={[PA]}
        outputs={salidas}
        onSave={onSave}
        onTest={vi.fn(async () => ok({ commandId: "cmd-1" }))}
        onStatus={vi.fn(async () => estado("ok"))}
      />,
    );
    const form = screen.getByRole("form", { name: "PNL-AAAA-AAAA S2" });
    fireEvent.click(within(form).getByRole("button", { name: "Probar S2" }));
    await avanzar(1000);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("mientras S1 espera su resultado, guardar S2 termina sin esperar a la prueba", async () => {
    const { form } = montar();
    fireEvent.click(within(form).getByRole("button", { name: "Probar S1" }));
    await avanzar(1000);
    const s2 = screen.getByRole("form", { name: "PNL-AAAA-AAAA S2" });
    fireEvent.click(within(s2).getByRole("button", { name: "Guardar S2" }));
    await avanzar(0);
    expect(within(s2).getByText("Se guardó S2.")).toBeTruthy();
    expect(within(s2).getByRole("button", { name: "Guardar S2" })).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Probando…" })).toBeTruthy();
    await avanzar(7000);
  });
});
