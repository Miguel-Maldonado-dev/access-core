// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import ImportReview from "@/components/panels/ImportReview";
import PanelsManager from "@/components/panels/PanelsManager";
import InstallationsManager from "@/components/installations/InstallationsManager";
import type { ActionResult } from "@/lib/actions";
import { IMPORT_STALE_MESSAGE, NO_PENDING_IMPORT_MESSAGE } from "@/lib/device/import-messages";
import type { ConfirmImportResult, ImportDiff } from "@/lib/device/imports";
import type { PanelRow } from "@/lib/panels/view";

/**
 * Interfaz de instalaciones, paneles e importación: las server actions se sustituyen por
 * funciones de prueba para ver qué manda cada control y cómo muestra la respuesta.
 */
const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const fallo = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refresh.mockClear();
  push.mockClear();
});

const panel = (parcial: Partial<PanelRow> = {}): PanelRow => ({
  id: "p-1",
  panel_code: "PNL-AAAA-BBBB",
  status: "active",
  online: true,
  last_sync_at: "2026-10-27T15:30:00.000Z",
  synced_revision: 7,
  software_version: "1.4.0",
  sync_blocked: null,
  ...parcial,
});

function montarPaneles(
  paneles: PanelRow[],
  { revision = 7, canAdmin = true }: { revision?: number; canAdmin?: boolean } = {},
) {
  const props = {
    installationId: "inst-1",
    basePath: "/t/t-1/installations/inst-1/paneles",
    installationRevision: revision,
    panels: paneles,
    canAdmin,
    onClaim: vi.fn(async () => ok({ id: "p-9", panel_code: "PNL-CCCC-DDDD", status: "claimed" as const, installation_id: "inst-1" })),
    onRevoke: vi.fn(async () => ok(undefined)),
    onConfirmDeletions: vi.fn(async () => ok(undefined)),
  };
  render(<PanelsManager {...props} />);
  return props;
}

describe("PanelsManager (pestaña Paneles)", () => {
  it("muestra Fuera de línea cuando online es false y En línea cuando es true", () => {
    montarPaneles([panel({ online: false }), panel({ id: "p-2", panel_code: "PNL-CCCC-DDDD", online: true })]);
    const filas = screen.getAllByRole("row").slice(1);
    expect(within(filas[0]).getByText("Fuera de línea")).toBeTruthy();
    expect(within(filas[1]).getByText("En línea")).toBeTruthy();
  });

  it("muestra el estado en español, la versión y la revisión", () => {
    montarPaneles([panel({ status: "awaiting_review" })]);
    const fila = screen.getAllByRole("row")[1];
    expect(within(fila).getByText("En revisión")).toBeTruthy();
    expect(within(fila).getByText("1.4.0")).toBeTruthy();
    expect(within(fila).getByText(/7 de 7/)).toBeTruthy();
  });

  it("marca la revisión atrasada si synced_revision < la de la instalación", () => {
    montarPaneles([panel({ synced_revision: 4 }), panel({ id: "p-2", panel_code: "PNL-CCCC-DDDD", synced_revision: 9 })], {
      revision: 9,
    });
    const filas = screen.getAllByRole("row").slice(1);
    expect(within(filas[0]).getByText(/4 de 9/)).toBeTruthy();
    expect(within(filas[0]).getByText("Atrasado")).toBeTruthy();
    expect(within(filas[1]).queryByText("Atrasado")).toBeNull();
  });

  it("muestra el aviso inicial que llega al volver de una importación ya resuelta", () => {
    const props = {
      installationId: "inst-1",
      basePath: "/x",
      installationRevision: 1,
      panels: [],
      canAdmin: true,
      initialNotice: { kind: "error", text: "Ya se resolvió." } as const,
      onClaim: vi.fn(),
      onRevoke: vi.fn(),
      onConfirmDeletions: vi.fn(),
    };
    render(<PanelsManager {...props} />);
    expect(screen.getByRole("alert").textContent).toBe("Ya se resolvió.");
  });

  it("ofrece Revisar importación en awaiting_review", () => {
    montarPaneles([panel({ status: "awaiting_review" })]);
    const enlace = screen.getByRole("link", { name: /Revisar importación/ });
    expect(enlace.getAttribute("href")).toBe("/t/t-1/installations/inst-1/paneles/p-1/importacion");
  });

  it("avisa cuántos borraría de cuántos y confirma los borrados", async () => {
    const props = montarPaneles([panel({ sync_blocked: { table: "cards", would_delete: 30, total: 100 } })]);
    expect(screen.getByText(/30 de 100/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar borrados/ }));
    await waitFor(() => expect(props.onConfirmDeletions).toHaveBeenCalledWith("p-1"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/PNL-AAAA-BBBB/));
  });

  it("Revocar pide confirmación y no actúa si se cancela", async () => {
    const props = montarPaneles([panel()]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: /Revocar/ }));
    expect(window.confirm).toHaveBeenCalled();
    expect(props.onRevoke).not.toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Revocar/ }));
    await waitFor(() => expect(props.onRevoke).toHaveBeenCalledWith("p-1"));
  });

  it("no ofrece Revocar en un panel ya revocado", () => {
    montarPaneles([panel({ status: "revoked", online: false })]);
    expect(screen.queryByRole("button", { name: /Revocar/ })).toBeNull();
  });

  it("vincula un panel con su código y el código de vinculación", async () => {
    const props = montarPaneles([]);
    fireEvent.change(screen.getByLabelText("Código del panel"), { target: { value: "PNL-CCCC-DDDD" } });
    fireEvent.change(screen.getByLabelText("Código de vinculación"), { target: { value: "ABCD2345" } });
    fireEvent.click(screen.getByRole("button", { name: "Vincular panel" }));
    await waitFor(() => expect(props.onClaim).toHaveBeenCalledWith("inst-1", "PNL-CCCC-DDDD", "ABCD2345"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/PNL-CCCC-DDDD/));
  });

  it("muestra el error de vinculación", async () => {
    const props = montarPaneles([]);
    props.onClaim.mockResolvedValue(fallo("El panel no existe o el código de vinculación es incorrecto.", 400));
    fireEvent.change(screen.getByLabelText("Código del panel"), { target: { value: "PNL-CCCC-DDDD" } });
    fireEvent.change(screen.getByLabelText("Código de vinculación"), { target: { value: "ABCD2345" } });
    fireEvent.click(screen.getByRole("button", { name: "Vincular panel" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/código de vinculación es incorrecto/);
  });

  it("un técnico no ve Vincular panel, Revocar ni Confirmar borrados", () => {
    montarPaneles([panel({ sync_blocked: { table: "cards", would_delete: 30, total: 100 } })], { canAdmin: false });
    expect(screen.queryByRole("button", { name: "Vincular panel" })).toBeNull();
    expect(screen.queryByLabelText("Código del panel")).toBeNull();
    expect(screen.queryByRole("button", { name: /Revocar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Confirmar borrados/ })).toBeNull();
    // pero ve el aviso
    expect(screen.getByText(/30 de 100/)).toBeTruthy();
  });
});

describe("ImportReview (revisión de importación)", () => {
  const diff: ImportDiff = {
    onlyInPanel: [
      {
        type: "holder",
        id: "s-dora",
        kind: "persona",
        name: "Dora",
        department: "Casa 9",
        has_pin: true,
        cards: [{ id: "s-k1", card_code: 3003, description: "" }],
        controls: [
          {
            id: "s-c1",
            description: "Control Dora",
            buttons: [{ id: "s-b1", button: 0, rf_code: 6006, output_id: 0 }],
          },
        ],
      },
      { type: "card", id: "s-k2", holder_name: "Ana Pérez", card_code: 4004, description: "" },
      { type: "button", id: "s-b9", holder_name: "Beto", control_description: "Control Beto", button: 1, rf_code: 7007, output_id: null },
    ],
    conflicts: [{ type: "card", id: "s-k3", holder_name: "Casa 5", card_code: 2002, reason: "La tarjeta 2002 ya es de otro titular (Beto)." }],
  };

  type Confirmar = (panelId: string, ids: string[]) => Promise<ActionResult<ConfirmImportResult>>;

  function montar(opciones: { canImport?: boolean; onConfirm?: Mock<Confirmar> } = {}) {
    const onConfirm: Mock<Confirmar> =
      opciones.onConfirm ?? vi.fn<Confirmar>(async () => ok({ imported: ["s-k2"], ignored: [] }));
    render(
      <ImportReview
        panelId="p-1"
        panelCode="PNL-AAAA-BBBB"
        backHref="/t/t-1/installations/inst-1/paneles"
        diff={diff}
        canImport={opciones.canImport ?? true}
        onConfirm={onConfirm}
      />,
    );
    return onConfirm;
  }

  it("muestra titulares con tarjetas, controles y PIN (nunca el valor), botones sueltos y conflictos", () => {
    montar();
    expect(screen.getByText("Dora")).toBeTruthy();
    expect(screen.getByText(/Tarjeta 3003/)).toBeTruthy();
    expect(screen.getByText(/Control Dora/)).toBeTruthy();
    expect(screen.getByText(/RF 6006/)).toBeTruthy();
    expect(screen.getByText(/Con PIN/)).toBeTruthy();
    expect(screen.getByText(/RF 7007/)).toBeTruthy();
    expect(screen.getByText("La tarjeta 2002 ya es de otro titular (Beto).")).toBeTruthy();
    // los conflictos son solo lectura
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("envía solo los IDs marcados", async () => {
    const onConfirm = montar();
    fireEvent.click(screen.getByRole("checkbox", { name: /Tarjeta 4004/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /RF 7007/ }));
    fireEvent.click(screen.getByRole("button", { name: "Importar seleccionados" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const [panelId, ids] = onConfirm.mock.calls[0];
    expect(panelId).toBe("p-1");
    expect([...ids].sort()).toEqual(["s-b9", "s-k2"]);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/t/t-1/installations/inst-1/paneles"));
  });

  it("permite importar sin marcar nada (solo se activa el panel)", async () => {
    const onConfirm = montar();
    fireEvent.click(screen.getByRole("button", { name: "Importar seleccionados" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("p-1", []));
  });

  it("si la instalación cambió, recarga el diff con un aviso y no navega", async () => {
    const onConfirm = montar({ onConfirm: vi.fn<Confirmar>(async () => fallo(IMPORT_STALE_MESSAGE)) });
    fireEvent.click(screen.getByRole("checkbox", { name: /Tarjeta 4004/ }));
    fireEvent.click(screen.getByRole("button", { name: "Importar seleccionados" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cambió/);
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("checkbox", { name: /Tarjeta 4004/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("si ya no hay importación pendiente, vuelve a Paneles con un aviso y no recarga", async () => {
    montar({ onConfirm: vi.fn<Confirmar>(async () => fallo(NO_PENDING_IMPORT_MESSAGE)) });
    fireEvent.click(screen.getByRole("button", { name: "Importar seleccionados" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/t/t-1/installations/inst-1/paneles?aviso=sin-importacion"),
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("un técnico ve la lista sin casillas habilitadas ni el botón", () => {
    montar({ canImport: false });
    expect(screen.queryByRole("button", { name: "Importar seleccionados" })).toBeNull();
    for (const c of screen.queryAllByRole("checkbox")) expect((c as HTMLInputElement).disabled).toBe(true);
  });
});

describe("InstallationsManager", () => {
  const instalaciones = [
    { id: "i-1", name: "Torre Norte", revision: 3 },
    { id: "i-2", name: "Torre Sur", revision: 0 },
  ];

  function montar(canCreate: boolean) {
    const props = {
      tenantId: "t-1",
      installations: instalaciones,
      canCreate,
      onCreate: vi.fn(async () => ok({ id: "i-3" })),
      onRename: vi.fn(async () => ok(undefined)),
    };
    render(<InstallationsManager {...props} />);
    return props;
  }

  it("enlaza cada instalación a su pestaña Paneles", () => {
    montar(true);
    expect(screen.getByRole("link", { name: "Torre Norte" }).getAttribute("href")).toBe(
      "/t/t-1/installations/i-1/paneles",
    );
  });

  it("el admin da de alta una instalación", async () => {
    const props = montar(true);
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Torre Este" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear instalación" }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith("t-1", "Torre Este"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Torre Este/));
  });

  it("un técnico no ve el alta pero sí puede renombrar", async () => {
    const props = montar(false);
    expect(screen.queryByRole("button", { name: "Crear instalación" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Renombrar.*Torre Norte/ }));
    const campo = screen.getByLabelText("Nuevo nombre de Torre Norte");
    fireEvent.change(campo, { target: { value: "Torre Poniente" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith("t-1", "i-1", "Torre Poniente"));
  });
});
