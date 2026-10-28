import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PermissionsPage from "./page";

const perms = vi.hoisted(() => [
  { permission_id: 0, name: "Acceso total", output_mask: 15, card_reader_mask: 5, pin_reader_mask: 0, weekday_mask: 127, start_minute: 0, end_minute: 0, allow_rf: true },
  { permission_id: 1, name: "Solo PIN", output_mask: 1, card_reader_mask: 0, pin_reader_mask: 10, weekday_mask: 31, start_minute: 0, end_minute: 0, allow_rf: false },
]);
const cloud = vi.hoisted(() => ({ state: "unlinked" }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => Promise.resolve(path === "/api/cloud/status" ? { state: cloud.state } : perms),
}));

const SHARED = "Este permiso es un perfil de la instalación: se borrará también en los demás paneles.";

afterEach(() => {
  cloud.state = "unlinked";
  vi.restoreAllMocks();
});

describe("PermissionsPage", () => {
  it("muestra Salidas, Tarjeta, PIN y RF abreviados por permiso", async () => {
    render(<PermissionsPage />);
    const headers = (await screen.findAllByRole("columnheader")).map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Tarjeta", "PIN", "RF"]));
    expect(headers).not.toContain("Lectores");
    const col = (name: string) => headers.indexOf(name);
    const first = within((await screen.findByText("Acceso total")).closest("tr")!).getAllByRole("cell");
    expect(first[col("Salidas")]).toHaveTextContent("S1, S2, S3, S4");
    expect(first[col("Salidas")]).toHaveAttribute("title", "Relay1, Relay2, Relay3, Relay4");
    expect(first[col("Tarjeta")]).toHaveTextContent("L1, L3");
    expect(first[col("Tarjeta")]).toHaveAttribute("title", "Reader1, Reader3");
    expect(first[col("PIN")]).toHaveTextContent("—");
    expect(first[col("RF")]).toHaveTextContent("Sí");
    const second = within(screen.getByText("Solo PIN").closest("tr")!).getAllByRole("cell");
    expect(second[col("Salidas")]).toHaveTextContent("S1");
    expect(second[col("Tarjeta")]).toHaveTextContent("—");
    expect(second[col("PIN")]).toHaveTextContent("L2, L4");
    expect(second[col("PIN")]).toHaveAttribute("title", "Reader2, Reader4");
    expect(second[col("RF")]).toHaveTextContent("—");
  });

  async function confirmTextAfterBorrar(): Promise<string> {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PermissionsPage />);
    const row = (await screen.findByText("Solo PIN")).closest("tr")!;
    // Deja que termine la consulta del estado de la nube antes de pulsar.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Borrar" })).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(within(row).getByRole("button", { name: "Borrar" }));
    return String(confirmSpy.mock.calls[0][0]);
  }

  it("con el panel vinculado, la confirmación de borrado avisa que se borra en los demás paneles", async () => {
    cloud.state = "active";
    const text = await confirmTextAfterBorrar();
    expect(text).toContain('¿Borrar el permiso 1 "Solo PIN"?');
    expect(text).toContain(SHARED);
  });

  it("sin vincular, la confirmación de borrado no menciona otros paneles", async () => {
    const text = await confirmTextAfterBorrar();
    expect(text).toContain('¿Borrar el permiso 1 "Solo PIN"?');
    expect(text).not.toContain(SHARED);
  });
});
