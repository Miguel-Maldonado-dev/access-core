// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConflictsManager from "@/components/conflicts/ConflictsManager";
import LogFilters from "@/components/logs/LogFilters";
import LogTable from "@/components/logs/LogTable";
import RefreshLogsButton from "@/components/logs/RefreshLogsButton";
import Pagination from "@/components/Pagination";
import type { ActionResult } from "@/lib/actions";
import type { ConflictRow } from "@/lib/conflict-view";
import { parseLogFilters, type LogRow } from "@/lib/log-view";

/** Interfaz de logs y conflictos: las server actions se sustituyen por funciones de prueba. */
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  refresh.mockClear();
});

const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });

const log = (p: Partial<LogRow> = {}): LogRow => ({
  id: 1,
  ts: "2026-03-10T18:30:00+00:00",
  panel_id: "pa",
  panel_code: "PNL-AAAA-AAAA",
  allowed: true,
  source: 0,
  reason: 0,
  holder_id: "h-1",
  holder_name: "Ana Pérez",
  holder_kind: "persona",
  credential_label: "Tarjeta azul",
  control_id: null,
  code: 3055412,
  device_id: 1,
  output_index: 0,
  output_alias: "Pluma vehicular",
  ...p,
});

describe("LogTable", () => {
  it("muestra las columnas del contrato y la salida con su alias", () => {
    render(<LogTable rows={[log()]} />);
    for (const t of ["Fecha", "Panel", "Resultado", "Titular", "Medio", "Código", "Salida", "Motivo"]) {
      expect(screen.getByRole("columnheader", { name: t })).toBeTruthy();
    }
    const fila = screen.getAllByRole("row")[1];
    expect(within(fila).getByText("Pluma vehicular")).toBeTruthy();
    expect(within(fila).getByText("PNL-AAAA-AAAA")).toBeTruthy();
    expect(within(fila).getByText("Permitido", { selector: "td:nth-child(3)" })).toBeTruthy();
    expect(within(fila).getByText("Ana Pérez · Persona")).toBeTruthy();
    expect(within(fila).getByText("Tarjeta azul · L2")).toBeTruthy();
    // Hora de México (UTC-6): 18:30 UTC = 12:30.
    expect(within(fila).getByText(/10\/03\/2026,? 12:30:00/)).toBeTruthy();
  });

  it("sin alias muestra S1 a S4 y sin salida un guion; el código va en decimal", () => {
    render(<LogTable rows={[log({ output_index: 2, output_alias: null }), log({ id: 2, output_index: null, output_alias: null, code: null })]} />);
    const filas = screen.getAllByRole("row");
    expect(within(filas[1]).getByText("S3")).toBeTruthy();
    expect(within(filas[1]).getByText("3055412")).toBeTruthy();
    expect(within(filas[2]).getAllByText("-").length).toBeGreaterThanOrEqual(2);
  });

  it("un log de PIN nunca muestra código, aunque llegara uno", () => {
    const { container } = render(<LogTable rows={[log({ source: 3, code: 123456, credential_label: null })]} />);
    expect(container.innerHTML).not.toContain("123456");
    expect(screen.getByText("PIN · L2")).toBeTruthy();
  });

  it("marca los denegados con su motivo", () => {
    render(<LogTable rows={[log({ allowed: false, reason: 8, source: 3, code: null })]} />);
    const fila = screen.getAllByRole("row")[1];
    expect(within(fila).getByText("Denegado")).toBeTruthy();
    expect(within(fila).getByText("PIN desconocido")).toBeTruthy();
  });

  it("sin filas dice que no hay registros", () => {
    render(<LogTable rows={[]} />);
    expect(screen.getByText("No hay registros con estos filtros.")).toBeTruthy();
  });
});

describe("RefreshLogsButton", () => {
  const PEDIDA = "2026-03-10T18:30:00.000Z";
  const PA = { id: "pa", panel_code: "PNL-AAAA-AAAA", online: true };
  const PB = { id: "pb", panel_code: "PNL-BBBB-BBBB", online: false };
  /** Avanza el reloj falso y deja correr las promesas pendientes. */
  const avanzar = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  function montar(
    onStatus = vi.fn<(since: string) => Promise<ActionResult<{ pending: string[] }>>>(async () => ok({ pending: ["pa"] })),
    onRequest = vi.fn(async () => ok({ requestedAt: PEDIDA, panels: [PA] })),
  ) {
    vi.useFakeTimers();
    render(<RefreshLogsButton onRequest={onRequest} onStatus={onStatus} />);
    return { onRequest, onStatus };
  }
  const pulsar = () => fireEvent.click(screen.getByRole("button", { name: "Actualizar logs" }));

  it("pide la subida, consulta cada 2 s y refresca cuando ya no hay pendientes", async () => {
    const onStatus = vi.fn<(since: string) => Promise<ActionResult<{ pending: string[] }>>>(async () => ok({ pending: [] }));
    onStatus.mockResolvedValueOnce(ok({ pending: ["pa"] }));
    const { onRequest } = montar(onStatus);
    pulsar();
    await avanzar(0);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sincronizando…" })).toBeTruthy();
    await avanzar(1999);
    expect(onStatus).not.toHaveBeenCalled();
    await avanzar(1);
    expect(onStatus).toHaveBeenCalledWith(PEDIDA);
    expect(refresh).not.toHaveBeenCalled();
    await avanzar(2000);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Actualizar logs" })).toBeTruthy();
    await avanzar(10_000);
    expect(onStatus).toHaveBeenCalledTimes(2);
  });

  it("a los 15 s refresca aunque haya paneles pendientes", async () => {
    const { onStatus } = montar();
    pulsar();
    await avanzar(14_999);
    expect(refresh).not.toHaveBeenCalled();
    await avanzar(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("PNL-AAAA-AAAA");
    // Es una advertencia, no una confirmación.
    const aviso = screen.getByText("Sin respuesta de PNL-AAAA-AAAA: se muestra lo último recibido.");
    expect(aviso.closest(".text-warn")).not.toBeNull();
    expect(aviso.closest(".notice-ok")).toBeNull();
    const llamadas = onStatus.mock.calls.length;
    await avanzar(10_000);
    expect(onStatus).toHaveBeenCalledTimes(llamadas);
  });

  it("muestra los paneles sin conexión", async () => {
    montar(
      vi.fn(async () => ok({ pending: [] as string[] })),
      vi.fn(async () => ok({ requestedAt: PEDIDA, panels: [PA, PB] })),
    );
    pulsar();
    await avanzar(0);
    // Dentro de la región role="status" (aria-live polite): el lector de pantalla la anuncia.
    expect(within(screen.getByRole("status")).getByText("Panel PNL-BBBB-BBBB sin conexión")).toBeTruthy();
    expect(screen.queryByText("Panel PNL-AAAA-AAAA sin conexión")).toBeNull();
    await avanzar(2000);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Lo último recibido del panel sin conexión se sigue mostrando, con su aviso.
    expect(screen.getByText("Panel PNL-BBBB-BBBB sin conexión")).toBeTruthy();
  });

  it("si ningún panel está en línea refresca sin consultar", async () => {
    const { onStatus } = montar(undefined, vi.fn(async () => ok({ requestedAt: PEDIDA, panels: [PB] })));
    pulsar();
    await avanzar(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalled();
    expect(screen.getByText("Panel PNL-BBBB-BBBB sin conexión")).toBeTruthy();
  });

  it("si pedir la subida lanza (red o base) muestra un error y refresca", async () => {
    const { onStatus } = montar(
      undefined,
      vi.fn(async (): Promise<ActionResult<{ requestedAt: string; panels: (typeof PA)[] }>> => {
        throw new Error("fetch failed");
      }),
    );
    pulsar();
    await avanzar(0);
    expect(screen.getByRole("alert").textContent).toBe("No se pudo consultar el panel. Intenta de nuevo.");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Actualizar logs" })).toBeTruthy();
    await avanzar(20_000);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("si la consulta lanza muestra un error, deja de consultar y refresca", async () => {
    const onStatus = vi.fn(async (): Promise<ActionResult<{ pending: string[] }>> => {
      throw new Error("fetch failed");
    });
    montar(onStatus);
    pulsar();
    await avanzar(2000);
    expect(screen.getByRole("alert").textContent).toBe("No se pudo consultar el panel. Intenta de nuevo.");
    expect(refresh).toHaveBeenCalledTimes(1);
    await avanzar(20_000);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("si se sale de la página mientras pide la subida, no consulta ni refresca", async () => {
    let responder: (r: ActionResult<{ requestedAt: string; panels: (typeof PA)[] }>) => void = () => {};
    const onRequest = vi.fn(
      () => new Promise<ActionResult<{ requestedAt: string; panels: (typeof PA)[] }>>((r) => (responder = r)),
    );
    const { onStatus } = montar(undefined, onRequest);
    pulsar();
    await avanzar(0);
    cleanup();
    // Sin paneles en línea se refrescaría de inmediato: el desmontaje debe impedirlo.
    responder(ok({ requestedAt: PEDIDA, panels: [PB] }));
    await avanzar(20_000);
    expect(onStatus).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("muestra el 429 y no consulta ni refresca", async () => {
    const mensaje = "Espera unos segundos antes de volver a actualizar.";
    const { onStatus } = montar(undefined, vi.fn(async () => fallo(mensaje, 429)));
    pulsar();
    await avanzar(0);
    expect(screen.getByRole("alert").textContent).toBe(mensaje);
    await avanzar(20_000);
    expect(onStatus).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Actualizar logs" })).toBeTruthy();
  });
});

describe("LogFilters", () => {
  const paneles = [{ id: "pa", panel_code: "PNL-AAAA-AAAA" }];
  const titulares = [{ id: "h-1", name: "Ana Pérez" }];

  it("es un formulario GET con los nombres de parámetro de la URL; Origen = PIN vale 3", () => {
    const { container } = render(<LogFilters action="/logs" filters={{ page: 1 }} panels={paneles} holders={titulares} />);
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/logs");
    const origen = screen.getByLabelText("Origen") as HTMLSelectElement;
    expect(origen.name).toBe("origen");
    expect(within(origen).getByRole("option", { name: "PIN" }).getAttribute("value")).toBe("3");
    fireEvent.change(origen, { target: { value: "3" } });
    // El formulario manda exactamente source=3 como `origen=3`.
    const datos = new FormData(form);
    expect(datos.get("origen")).toBe("3");
    expect(datos.get("resultado")).toBe("");
    expect(datos.has("pagina")).toBe(false);
    for (const n of ["desde", "hasta", "panel", "titular", "resultado"]) expect(datos.has(n)).toBe(true);
  });

  it("muestra seleccionados los filtros de la URL", () => {
    const f = parseLogFilters({ origen: "3", resultado: "denegado", panel: "6f9619ff-8b86-d011-b42d-00c04fc964ff", desde: "2026-03-10" });
    render(<LogFilters action="/logs" filters={f} panels={paneles} holders={titulares} />);
    expect((screen.getByLabelText("Origen") as HTMLSelectElement).value).toBe("3");
    expect((screen.getByLabelText("Resultado") as HTMLSelectElement).value).toBe("denegado");
    expect((screen.getByLabelText("Desde") as HTMLInputElement).value).toBe("2026-03-10");
  });

  it("se puede filtrar por el origen Prueba (5)", () => {
    render(<LogFilters action="/logs" filters={{ page: 1 }} panels={paneles} holders={titulares} />);
    expect(within(screen.getByLabelText("Origen")).getByRole("option", { name: "Prueba" }).getAttribute("value")).toBe("5");
  });

  it("lista los paneles y los titulares", () => {
    render(<LogFilters action="/logs" filters={{ page: 1 }} panels={paneles} holders={titulares} />);
    expect(within(screen.getByLabelText("Panel")).getByRole("option", { name: "PNL-AAAA-AAAA" })).toBeTruthy();
    expect(within(screen.getByLabelText("Titular")).getByRole("option", { name: "Ana Pérez" })).toBeTruthy();
  });
});

describe("Pagination", () => {
  const href = (p: number) => `/logs?origen=3${p > 1 ? `&pagina=${p}` : ""}`;

  it("muestra el rango, la página y enlaces que conservan los filtros", () => {
    render(<Pagination page={2} pageSize={50} total={120} hrefFor={href} />);
    expect(screen.getByText("51–100 de 120")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Anterior" }).getAttribute("href")).toBe("/logs?origen=3");
    expect(screen.getByRole("link", { name: "Siguiente" }).getAttribute("href")).toBe("/logs?origen=3&pagina=3");
  });

  it("en los extremos no hay enlace de Anterior ni de Siguiente", () => {
    const { unmount } = render(<Pagination page={1} pageSize={50} total={120} hrefFor={href} />);
    expect(screen.queryByRole("link", { name: "Anterior" })).toBeNull();
    expect(screen.getByRole("link", { name: "Siguiente" })).toBeTruthy();
    unmount();
    render(<Pagination page={3} pageSize={50} total={120} hrefFor={href} />);
    expect(screen.queryByRole("link", { name: "Siguiente" })).toBeNull();
    expect(screen.getByText("101–120 de 120")).toBeTruthy();
  });

  it("una página fuera de rango avisa y ofrece volver a la última", () => {
    render(<Pagination page={9} pageSize={50} total={120} hrefFor={href} />);
    expect(screen.getByRole("link", { name: "Ir a la última página" }).getAttribute("href")).toBe("/logs?origen=3&pagina=3");
  });

  it("sin resultados no muestra nada", () => {
    const { container } = render(<Pagination page={1} pageSize={50} total={0} hrefFor={href} />);
    expect(container.textContent).toBe("");
  });
});

const conflicto = (p: Partial<ConflictRow> = {}): ConflictRow => ({
  id: 7,
  panel_id: "pa",
  panel_code: "PNL-AAAA-AAAA",
  table_name: "cards",
  row_id: "r-1",
  kind: "unique",
  resolution: "Rechazado: duplicado.",
  created_at: "2026-03-10T18:30:00+00:00",
  reviewed_at: null,
  ...p,
});

describe("ConflictsManager", () => {
  const montar = (rows: ConflictRow[], onReview = vi.fn(async (): Promise<ActionResult> => ok(undefined))) => {
    render(<ConflictsManager rows={rows} onReview={onReview} />);
    return onReview;
  };

  it("un conflicto de unicidad muestra «Rechazado: duplicado»", () => {
    montar([conflicto()]);
    const fila = screen.getAllByRole("row")[1];
    expect(within(fila).getByText(/Rechazado: duplicado/)).toBeTruthy();
    expect(within(fila).getByText("Duplicado")).toBeTruthy();
    expect(within(fila).getByText("tarjetas")).toBeTruthy();
    expect(within(fila).getByText("PNL-AAAA-AAAA")).toBeTruthy();
    for (const t of ["Tipo", "Tabla", "Panel", "Fecha", "Resolución"]) {
      expect(screen.getByRole("columnheader", { name: t })).toBeTruthy();
    }
  });

  it("«Marcar como revisado» llama a la acción con el id y confirma", async () => {
    const onReview = montar([conflicto()]);
    fireEvent.click(screen.getByRole("button", { name: "Marcar como revisado" }));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith(7));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("revisado"));
  });

  it("si la acción falla muestra el error", async () => {
    montar([conflicto()], vi.fn(async () => fallo("El conflicto no existe.", 404)));
    fireEvent.click(screen.getByRole("button", { name: "Marcar como revisado" }));
    expect((await screen.findByRole("alert")).textContent).toBe("El conflicto no existe.");
  });

  it("un conflicto revisado sigue en la lista con la fecha y sin botón", () => {
    montar([conflicto({ reviewed_at: "2026-03-11T18:00:00+00:00" }), conflicto({ id: 8, kind: "skew", resolution: "Hora del panel adelantada: se usó la hora del servidor." })]);
    const filas = screen.getAllByRole("row");
    expect(within(filas[1]).queryByRole("button")).toBeNull();
    expect(within(filas[1]).getByText(/Revisado/)).toBeTruthy();
    expect(within(filas[1]).getByText(/11\/03\/2026/)).toBeTruthy();
    expect(within(filas[2]).getByRole("button", { name: "Marcar como revisado" })).toBeTruthy();
    expect(within(filas[2]).getByText("Reloj desfasado")).toBeTruthy();
  });

  it("sin conflictos lo dice", () => {
    montar([]);
    expect(screen.getByText("No hay conflictos de sincronización.")).toBeTruthy();
  });
});
