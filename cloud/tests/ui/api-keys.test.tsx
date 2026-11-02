// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sectionsFor } from "@/app/t/[tenant]/sections";
import ApiKeysManager from "@/components/api/ApiKeysManager";
import type { ActionResult } from "@/lib/actions";
import type { ApiKeyRow, CreatedApiKey } from "@/lib/api/keys";

/** Interfaz de /t/[tenant]/api: las server actions se sustituyen por funciones de prueba. */
const SECRETO = `acc_${"A".repeat(43)}`;
const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const llave = (extra: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: "k-1",
  name: "Integración",
  prefix: "acc_AAAAAAAA",
  created_at: "2026-11-01T10:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
  ...extra,
});
const creada = (): CreatedApiKey => ({ key: llave({ id: "k-2", name: "Nueva" }), secret: SECRETO });

function montar(keys: ApiKeyRow[], extra: Partial<React.ComponentProps<typeof ApiKeysManager>> = {}) {
  const props = {
    tenantId: "t-1",
    keys,
    onCreate: vi.fn(async () => ok(creada())),
    onRevoke: vi.fn(async () => ok(undefined)),
    onRotate: vi.fn(async () => ok(creada())),
    ...extra,
  };
  return { props, ...render(<ApiKeysManager {...props} />) };
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ApiKeysManager", () => {
  it("lista las llaves con su estado y enlaza al OpenAPI", () => {
    montar([llave(), llave({ id: "k-3", name: "Vieja", revoked_at: "2026-11-02T10:00:00.000Z" })]);
    expect(screen.getByRole("cell", { name: "Integración" })).toBeTruthy();
    expect(screen.getByText("Activa")).toBeTruthy();
    expect(screen.getByText("Revocada")).toBeTruthy();
    expect(screen.getByRole("link", { name: /openapi/i }).getAttribute("href")).toBe("/api/v1/openapi.json");
  });

  it("al crear muestra el secreto una sola vez y al recargar ya no está", async () => {
    const { props, unmount } = montar([llave()]);
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Nueva" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear llave" }));
    await waitFor(() => expect(screen.getByText(SECRETO)).toBeTruthy());
    expect(props.onCreate).toHaveBeenCalledWith("t-1", "Nueva");
    expect(screen.getByText("Guárdala ahora: no se volverá a mostrar.")).toBeTruthy();
    unmount();
    montar([llave(), llave({ id: "k-2", name: "Nueva" })]);
    expect(screen.queryByText(SECRETO)).toBeNull();
  });

  it("el aviso del secreto es una región viva y recibe el foco al crear y al rotar", async () => {
    montar([llave()]);
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Nueva" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear llave" }));
    const aviso = await screen.findByRole("region", { name: /Secreto de/ });
    expect(aviso.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(document.activeElement).toBe(aviso));
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(screen.getByRole("button", { name: /Rotar/ }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: /Secreto de/ })));
  });

  it("el secreto sigue visible cuando llegan llaves nuevas (refresh)", async () => {
    const { props, rerender } = montar([llave()]);
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Nueva" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear llave" }));
    await screen.findByText(SECRETO);
    rerender(<ApiKeysManager {...props} keys={[llave(), llave({ id: "k-2", name: "Nueva" })]} />);
    expect(screen.getByText(SECRETO)).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Nueva" })).toBeTruthy();
  });

  it("Copiar usa el portapapeles y avisa si falla", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    montar([]);
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Nueva" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear llave" }));
    await screen.findByText(SECRETO);
    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRETO));
    writeText.mockRejectedValue(new Error("no"));
    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));
    await screen.findByText("Copia el texto manualmente.");
    expect(screen.getByText("Copia el texto manualmente.").getAttribute("aria-live")).toBe("polite");
  });

  it("revocar y rotar piden confirmación", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { props } = montar([llave()]);
    fireEvent.click(screen.getByRole("button", { name: /Revocar/ }));
    fireEvent.click(screen.getByRole("button", { name: /Rotar/ }));
    expect(confirmar).toHaveBeenCalledTimes(2);
    expect(props.onRevoke).not.toHaveBeenCalled();
    expect(props.onRotate).not.toHaveBeenCalled();

    confirmar.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Revocar/ }));
    await waitFor(() => expect(props.onRevoke).toHaveBeenCalledWith("t-1", "k-1"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe('Llave "Integración" revocada.'));
    fireEvent.click(screen.getByRole("button", { name: /Rotar/ }));
    await waitFor(() => expect(props.onRotate).toHaveBeenCalledWith("t-1", "k-1"));
    await screen.findByText(SECRETO);
  });

  it("muestra el error de la acción", async () => {
    montar([], { onCreate: vi.fn(async () => ({ ok: false as const, status: 409, error: "Ya hay 10 llaves activas." })) });
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear llave" }));
    await screen.findByText("Ya hay 10 llaves activas.");
  });
});

describe("pestaña API", () => {
  it("no aparece para un técnico y sí para un admin", () => {
    expect(sectionsFor("tecnico").map((s) => s.segment)).not.toContain("api");
    expect(sectionsFor("admin").map((s) => s.label)).toContain("API");
  });
});
