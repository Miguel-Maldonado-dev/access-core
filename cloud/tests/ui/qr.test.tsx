// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QrCodeForm from "@/components/access/QrCodeForm";
import QrCodesManager from "@/components/access/QrCodesManager";
import QrImage from "@/components/access/QrImage";
import QrSettingsForm from "@/components/access/QrSettingsForm";
import type { ActionResult } from "@/lib/actions";
import { QR_MAX_ACTIVE, QR_MAX_USES, QR_STATUS_LABELS, mexicoLocalToIso } from "@/lib/qr-view";
import { QR_MAX_ACTIVE as SERVER_MAX_ACTIVE } from "@/lib/installations";
import { QR_MAX_USES as SERVER_MAX_USES, type QrCodeRow } from "@/lib/qr-codes";

const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 422): ActionResult<never> => ({ ok: false, status, error: mensaje });

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
const qr = (p: Partial<QrCodeRow> = {}): QrCodeRow => ({
  id: "q-1",
  holder_id: "h-1",
  holder_name: "Ana Pérez",
  code: 1234567890,
  label: "Repartidor",
  valid_from: "2026-11-26T18:00:00.000Z",
  valid_until: "2026-11-27T18:00:00.000Z",
  max_uses: 3,
  status: "active",
  created_at: "2026-11-26T17:00:00.000Z",
  origin: "cloud",
  ...p,
});

describe("mexicoLocalToIso", () => {
  it("interpreta la hora capturada como hora de México (UTC-6)", () => {
    expect(mexicoLocalToIso("2026-11-26T12:30")).toBe("2026-11-26T18:30:00.000Z");
  });
  it("rechaza lo que no es fecha y hora", () => {
    expect(mexicoLocalToIso("")).toBeNull();
    expect(mexicoLocalToIso("ayer")).toBeNull();
  });
});

describe("constantes de QR", () => {
  it("los estados se rotulan Pendiente, Vigente y Vencido", () => {
    expect(QR_STATUS_LABELS).toEqual({ pending: "Pendiente", active: "Vigente", expired: "Vencido" });
  });
  it("coinciden con las del servidor", () => {
    expect(QR_MAX_USES).toBe(SERVER_MAX_USES);
    expect(QR_MAX_ACTIVE).toBe(SERVER_MAX_ACTIVE);
  });
});

describe("QrCodeForm", () => {
  const llenar = (desde: string, hasta: string, usos?: string) => {
    fireEvent.change(screen.getByLabelText("Anfitrión"), { target: { value: "h-1" } });
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: desde } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: hasta } });
    if (usos !== undefined) fireEvent.change(screen.getByLabelText("Usos máximos"), { target: { value: usos } });
  };

  it("pide elegir anfitrión", () => {
    const onSubmit = vi.fn();
    render(<QrCodeForm holders={HOLDERS} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(screen.getByRole("alert").textContent).toBe("Elige un anfitrión.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("exige que la vigencia termine después de empezar", () => {
    const onSubmit = vi.fn();
    render(<QrCodeForm holders={HOLDERS} onSubmit={onSubmit} onCancel={() => {}} />);
    llenar("2026-11-26T12:00", "2026-11-26T12:00");
    fireEvent.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(screen.getByRole("alert").textContent).toBe("La vigencia debe terminar después de empezar.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("exige fechas completas", () => {
    const onSubmit = vi.fn();
    render(<QrCodeForm holders={HOLDERS} onSubmit={onSubmit} onCancel={() => {}} />);
    llenar("", "");
    fireEvent.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(screen.getByRole("alert").textContent).toBe("Escribe cuándo empieza y cuándo termina la vigencia.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["0", "101", "1.5", ""])("rechaza %j usos", (usos) => {
    const onSubmit = vi.fn();
    render(<QrCodeForm holders={HOLDERS} onSubmit={onSubmit} onCancel={() => {}} />);
    llenar("2026-11-26T12:00", "2026-11-27T12:00", usos);
    fireEvent.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(screen.getByRole("alert").textContent).toBe("Los usos deben ser de 1 a 100.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("envía fechas en UTC, usos y etiqueta sin espacios", () => {
    const onSubmit = vi.fn();
    render(<QrCodeForm holders={HOLDERS} onSubmit={onSubmit} onCancel={() => {}} />);
    llenar("2026-11-26T12:00", "2026-11-27T12:00", "100");
    fireEvent.change(screen.getByLabelText("Etiqueta"), { target: { value: "  Visita " } });
    fireEvent.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(onSubmit).toHaveBeenCalledWith({
      holder_id: "h-1",
      label: "Visita",
      valid_from: "2026-11-26T18:00:00.000Z",
      valid_until: "2026-11-27T18:00:00.000Z",
      max_uses: 100,
    });
  });
});

describe("QrSettingsForm", () => {
  it("el técnico lo ve en solo lectura", () => {
    render(<QrSettingsForm settings={{ digit: 4, max_active: 500 }} canEdit={false} onSave={vi.fn()} />);
    expect(screen.getByLabelText("Dígito de QR").matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Máximo de QR vigentes").matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Guardar ajustes" })).toBeNull();
  });

  it("valida el dígito y el máximo antes de enviar", () => {
    const onSave = vi.fn();
    render(<QrSettingsForm settings={{ digit: 4, max_active: 500 }} canEdit onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Dígito de QR"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar ajustes" }));
    expect(screen.getByRole("alert").textContent).toBe("El dígito de QR debe ser de 1 a 9.");
    fireEvent.change(screen.getByLabelText("Dígito de QR"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Máximo de QR vigentes"), { target: { value: "100001" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar ajustes" }));
    expect(screen.getByRole("alert").textContent).toBe("El máximo de QR vigentes debe ser de 1 a 100000.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("guarda y muestra el 422 «Hay tarjetas en ese rango»", async () => {
    const onSave = vi.fn(async (): Promise<ActionResult> => fallo("Hay tarjetas en ese rango"));
    render(<QrSettingsForm settings={{ digit: 4, max_active: 500 }} canEdit onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Dígito de QR"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar ajustes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ digit: 7, max_active: 500 }));
    expect((await screen.findByRole("alert")).textContent).toBe("Hay tarjetas en ese rango");
  });

  it("confirma el guardado", async () => {
    const onSave = vi.fn(async () => ok(undefined));
    render(<QrSettingsForm settings={{ digit: 4, max_active: 500 }} canEdit onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Guardar ajustes" }));
    expect((await screen.findByRole("status")).textContent).toContain("Se guardaron los ajustes de QR.");
  });
});

describe("QrImage", () => {
  it("muestra la imagen, el número debajo y descarga como qr-<code>.png", async () => {
    render(<QrImage code={1234567890} />);
    const img = await screen.findByRole("img", { name: "Código QR 1234567890" });
    expect((img as HTMLImageElement).src).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByText("1234567890")).toBeTruthy();
    const enlace = screen.getByRole("link", { name: "Descargar PNG" }) as HTMLAnchorElement;
    expect(enlace.getAttribute("download")).toBe("qr-1234567890.png");
    expect(enlace.href).toMatch(/^data:image\/png;base64,/);
  });
});

describe("QrCodesManager", () => {
  const props = (extra: Partial<Parameters<typeof QrCodesManager>[0]> = {}) => ({
    codes: [qr(), qr({ id: "q-2", code: 1987654321, holder_id: "h-2", holder_name: "Luis Gómez", label: "", status: "expired", max_uses: 1 })],
    holders: HOLDERS,
    onCreate: vi.fn(async (): Promise<ActionResult<{ id: string }>> => ok({ id: "q-9" })),
    onDelete: vi.fn(async (): Promise<ActionResult> => ok(undefined)),
    ...extra,
  });

  it("lista anfitrión, etiqueta, vigencia en hora de México, usos y estado", () => {
    render(<QrCodesManager {...props()} />);
    const fila = screen.getAllByRole("row")[1];
    expect(within(fila).getByText("Ana Pérez")).toBeTruthy();
    expect(within(fila).getByText("Repartidor")).toBeTruthy();
    expect(within(fila).getByText(/26\/11\/2026, 12:00:00/)).toBeTruthy();
    expect(within(fila).getByText("3")).toBeTruthy();
    expect(within(fila).getByText("Vigente")).toBeTruthy();
    expect(within(screen.getAllByRole("row")[2]).getByText("Vencido")).toBeTruthy();
  });

  it("filtra por anfitrión", () => {
    render(<QrCodesManager {...props()} />);
    fireEvent.change(screen.getByLabelText("Filtrar por anfitrión"), { target: { value: "h-2" } });
    expect(screen.queryByText("Repartidor")).toBeNull();
    expect(screen.getByText("Luis Gómez", { selector: "td" })).toBeTruthy();
  });

  it("crea un QR y avisa", async () => {
    const p = props();
    render(<QrCodesManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Nuevo QR" }));
    fireEvent.change(await screen.findByLabelText("Anfitrión"), { target: { value: "h-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear QR" }));
    await waitFor(() => expect(p.onCreate).toHaveBeenCalled());
    expect(await screen.findByText("Se creó el QR.")).toBeTruthy();
  });

  it("muestra el error del servidor al crear (tope de vigentes)", async () => {
    const p = props({ onCreate: vi.fn(async () => fallo("Se alcanzó el máximo de QR vigentes.")) });
    render(<QrCodesManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Nuevo QR" }));
    fireEvent.change(await screen.findByLabelText("Anfitrión"), { target: { value: "h-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear QR" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Se alcanzó el máximo de QR vigentes.");
  });

  it("revoca con confirmación", async () => {
    const p = props();
    render(<QrCodesManager {...p} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Revocar/ })[0]);
    await waitFor(() => expect(p.onDelete).toHaveBeenCalledWith("q-1"));
    expect(await screen.findByText("Se revocó el QR 1234567890.")).toBeTruthy();
  });

  it("no revoca si se cancela la confirmación", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const p = props();
    render(<QrCodesManager {...p} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Revocar/ })[0]);
    expect(p.onDelete).not.toHaveBeenCalled();
  });

  it("«Ver QR» abre la imagen con el número", async () => {
    render(<QrCodesManager {...props()} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Ver QR/ })[0]);
    expect(await screen.findByRole("img", { name: "Código QR 1234567890" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Descargar PNG" })).toBeTruthy();
  });

  it("sin QR invita a crear el primero", () => {
    render(<QrCodesManager {...props({ codes: [] })} />);
    expect(screen.getByText("Aún no hay QR. Crea el primero con Nuevo QR.")).toBeTruthy();
  });
});
