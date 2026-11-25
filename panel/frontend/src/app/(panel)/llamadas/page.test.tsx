import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CallsPage from "./page";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const outputs = [
  { output_id: 0, duration_ms: 3000, reader_mask: 3, enabled: true, alias: "Pluma vehicular" },
  { output_id: 1, duration_ms: 3000, reader_mask: 12, enabled: true, alias: "" },
  { output_id: 2, duration_ms: 3000, reader_mask: 0, enabled: true, alias: "" },
  { output_id: 3, duration_ms: 3000, reader_mask: 0, enabled: true, alias: "" },
];
const baseSettings = {
  enabled: true, mode: "single", output_id: 0, menu_mask: 0, default_output: null, call_limit_per_minute: 3,
};
const baseStatus = { ok: true, enabled: true, port: "/dev/ttyUSB0", connected: true, registered: true, signal: 18 };

function serve(settings: object = baseSettings, status: object | Error = baseStatus) {
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/outputs") return Promise.resolve(outputs);
    if (path === "/api/calls/status") return status instanceof Error ? Promise.reject(status) : Promise.resolve(status);
    if (path === "/api/calls/settings" && init?.method === "PUT") return Promise.resolve(JSON.parse(init.body as string));
    if (path === "/api/calls/settings") return Promise.resolve(settings);
    return Promise.reject(new Error("ruta inesperada " + path));
  });
}

function lastPut() {
  const call = apiFetch.mock.calls.filter(([p, i]) => p === "/api/calls/settings" && i?.method === "PUT").at(-1);
  return JSON.parse(call![1].body as string);
}

describe("CallsPage", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    serve();
  });

  it("en modo Una salida oculta las salidas del menú y la predeterminada", async () => {
    render(<CallsPage />);
    expect(await screen.findByLabelText("Salida")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Salidas del menú" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Salida predeterminada")).not.toBeInTheDocument();
  });

  it("en modo Varias salidas muestra el menú y oculta el selector de salida", async () => {
    const user = userEvent.setup();
    render(<CallsPage />);
    await user.click(await screen.findByLabelText("Varias salidas"));
    expect(screen.getByRole("group", { name: "Salidas del menú" })).toBeInTheDocument();
    expect(screen.getByLabelText("Salida predeterminada")).toBeInTheDocument();
    expect(screen.queryByLabelText("Salida")).not.toBeInTheDocument();
  });

  it("muestra el alias en las salidas", async () => {
    render(<CallsPage />);
    expect(await screen.findByRole("option", { name: "S1 · Pluma vehicular" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "S2" })).toBeInTheDocument();
  });

  it("la salida predeterminada solo ofrece las salidas marcadas del menú", async () => {
    const user = userEvent.setup();
    serve({ ...baseSettings, mode: "menu", menu_mask: 0 });
    render(<CallsPage />);
    const select = await screen.findByLabelText("Salida predeterminada");
    expect(screen.getAllByRole("option", { name: "Ninguna" })).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "S2" })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("S2"));
    await user.selectOptions(select, "1");
    expect(select).toHaveValue("1");
    await user.click(screen.getByLabelText("S2"));
    expect(select).toHaveValue("");
  });

  it("guarda la configuración con el límite por minuto", async () => {
    const user = userEvent.setup();
    render(<CallsPage />);
    const limit = await screen.findByLabelText("Aperturas por minuto por número");
    expect(limit).toHaveValue(3);
    await user.clear(limit);
    await user.type(limit, "5");
    await user.selectOptions(screen.getByLabelText("Salida"), "2");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(lastPut()).toEqual({
      enabled: true, mode: "single", output_id: 2, menu_mask: 0, default_output: null, call_limit_per_minute: 5,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Configuración guardada");
  });

  it("envía el menú, la predeterminada y el límite actual al guardar", async () => {
    const user = userEvent.setup();
    serve({ ...baseSettings, mode: "menu", menu_mask: 3, default_output: 1 });
    render(<CallsPage />);
    await screen.findByLabelText("Salida predeterminada");
    await user.click(screen.getByLabelText("S3"));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(lastPut()).toEqual({
      enabled: true, mode: "menu", output_id: 0, menu_mask: 7, default_output: 1, call_limit_per_minute: 3,
    });
  });

  it("rechaza un límite fuera de 1 a 20 sin llamar al servidor", async () => {
    const user = userEvent.setup();
    render(<CallsPage />);
    const limit = await screen.findByLabelText("Aperturas por minuto por número");
    await user.clear(limit);
    await user.type(limit, "21");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Debe ser un número entre 1 y 20.");
    expect(apiFetch.mock.calls.some(([, i]) => i?.method === "PUT")).toBe(false);
  });

  it("muestra el error del servidor al guardar", async () => {
    const user = userEvent.setup();
    render(<CallsPage />);
    await screen.findByLabelText("Salida");
    apiFetch.mockRejectedValueOnce(new Error("La salida predeterminada debe estar entre las salidas del menú."));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("La salida predeterminada debe estar entre las salidas del menú.");
  });

  it("muestra el estado del módulo", async () => {
    render(<CallsPage />);
    const block = await screen.findByRole("region", { name: "Estado del módulo" });
    expect(await screen.findByText("/dev/ttyUSB0")).toBeInTheDocument();
    expect(block).toHaveTextContent("Registrado en la red");
    expect(block).toHaveTextContent("Sí");
    expect(block).toHaveTextContent("18/31");
  });

  it("muestra Sin dato cuando el módem no informa", async () => {
    serve(baseSettings, { ...baseStatus, registered: null, signal: null });
    render(<CallsPage />);
    const block = await screen.findByRole("region", { name: "Estado del módulo" });
    expect(await screen.findByText("/dev/ttyUSB0")).toBeInTheDocument();
    expect(block).toHaveTextContent("Señal");
    expect(block.textContent?.match(/Sin dato/g)).toHaveLength(2);
  });

  it("explica que el daemon no responde", async () => {
    serve(baseSettings, new Error("El daemon no responde"));
    render(<CallsPage />);
    expect(await screen.findByText("El daemon no responde")).toBeInTheDocument();
  });

  it("pide confirmación al desactivar y no guarda si se cancela", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CallsPage />);
    await user.click(await screen.findByLabelText("Activar módulo"));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(apiFetch.mock.calls.some(([p, i]) => p === "/api/calls/settings" && i?.method === "PUT")).toBe(false);
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(lastPut().enabled).toBe(false);
    confirmSpy.mockRestore();
  });

  it("avisa al menú tras guardar", async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener("acceso:calls-changed", listener);
    render(<CallsPage />);
    await screen.findByLabelText("Salida");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Configuración guardada")).toBeInTheDocument();
    expect(listener).toHaveBeenCalled();
    window.removeEventListener("acceso:calls-changed", listener);
  });

  it("el nombre de la casilla del menú incluye el alias", async () => {
    const user = userEvent.setup();
    render(<CallsPage />);
    await user.click(await screen.findByLabelText("Varias salidas"));
    expect(screen.getByRole("checkbox", { name: "S1 · Pluma vehicular" })).toBeInTheDocument();
  });
});
