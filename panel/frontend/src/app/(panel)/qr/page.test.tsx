import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QrPage from "./page";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const holders = [
  { holder_id: 1, kind: "persona", name: "Ana", department: "", address: "", notes: "", has_pin: false, permission_ids: [], card_count: 0, control_count: 0 },
];
const qrs = [
  { qr_id: 7, holder_id: 1, holder_name: "Ana", code: 912345678, label: "Plomero", valid_from: "2026-12-01T15:00:00Z", valid_until: "2026-12-02T00:00:00Z", max_uses: 2, status: "active", uses: { "0": 1 } },
  { qr_id: 8, holder_id: 1, holder_name: "Ana", code: 912345679, label: "", valid_from: "2026-11-01T15:00:00Z", valid_until: "2026-11-02T00:00:00Z", max_uses: 1, status: "expired", uses: {} },
  { qr_id: 9, holder_id: 1, holder_name: "Ana", code: 912345680, label: "Pronto", valid_from: "2030-11-01T15:00:00Z", valid_until: "2030-11-02T00:00:00Z", max_uses: 1, status: "pending", uses: {} },
];

function serve(settings: object = { digit: 9, max_active: 1000, editable: true }) {
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/holders") return Promise.resolve(holders);
    if (path.startsWith("/api/qr-codes") && init?.method === "DELETE") return Promise.resolve(undefined);
    if (path.startsWith("/api/qr-codes")) return Promise.resolve(qrs);
    if (path === "/api/qr-settings" && init?.method === "PUT") return Promise.resolve({ ...JSON.parse(init.body as string), editable: true });
    if (path === "/api/qr-settings") return Promise.resolve(settings);
    return Promise.reject(new Error("ruta inesperada " + path));
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  vi.restoreAllMocks();
  serve();
});

describe("QrPage", () => {
  it("lista los QR con estado, vigencia en hora de México y usos por lector", async () => {
    render(<QrPage />);
    const row = (await screen.findByText("Plomero")).closest("tr")!;
    expect(within(row).getByText("Vigente")).toBeInTheDocument();
    expect(within(row).getByText(/01\/12\/2026.*09:00/)).toBeInTheDocument();
    expect(within(row).getByText("L1: 1/2")).toBeInTheDocument();
    expect(screen.getByText("Vencido")).toBeInTheDocument();
    expect(screen.getByText("Pendiente")).toBeInTheDocument();
  });

  it("revoca con confirmación", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<QrPage />);
    const row = (await screen.findByText("Plomero")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Revocar" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledWith("/api/qr-codes/7", { method: "DELETE" });
  });

  it("no revoca si se cancela la confirmación", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<QrPage />);
    const row = (await screen.findByText("Plomero")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Revocar" }));
    expect(apiFetch).not.toHaveBeenCalledWith("/api/qr-codes/7", { method: "DELETE" });
  });

  it("Ver QR muestra la imagen con su número y la descarga", async () => {
    const user = userEvent.setup();
    render(<QrPage />);
    const row = (await screen.findByText("Plomero")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Ver QR" }));
    expect(await screen.findByRole("link", { name: "Descargar PNG" })).toHaveAttribute("download", "qr-912345678.png");
  });

  it("edita los ajustes y los guarda", async () => {
    const user = userEvent.setup();
    render(<QrPage />);
    const digit = await screen.findByLabelText("Dígito de QR");
    expect(digit).toBeEnabled();
    await user.clear(digit);
    await user.type(digit, "5");
    await user.click(screen.getByRole("button", { name: "Guardar ajustes" }));
    const call = apiFetch.mock.calls.find(([p, i]) => p === "/api/qr-settings" && i?.method === "PUT")!;
    expect(JSON.parse(call[1].body)).toEqual({ digit: 5, max_active: 1000 });
  });

  it("deshabilita los ajustes con editable en falso", async () => {
    serve({ digit: 9, max_active: 1000, editable: false });
    render(<QrPage />);
    expect(await screen.findByLabelText("Dígito de QR")).toBeDisabled();
    expect(screen.getByLabelText("Máximo de QR vigentes")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Guardar ajustes" })).toBeDisabled();
    expect(screen.getByText(/vinculado a la nube/i)).toBeInTheDocument();
  });

  it("si falla la carga de ajustes, muestra el error y no el formulario editable", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === "/api/holders") return Promise.resolve(holders);
      if (path.startsWith("/api/qr-codes")) return Promise.resolve(qrs);
      if (path === "/api/qr-settings") return Promise.reject(new Error("sin respuesta"));
      return Promise.reject(new Error("ruta inesperada " + path));
    });
    render(<QrPage />);
    expect(await screen.findByText("sin respuesta")).toBeInTheDocument();
    expect(screen.queryByLabelText("Dígito de QR")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar ajustes" })).not.toBeInTheDocument();
  });
});
