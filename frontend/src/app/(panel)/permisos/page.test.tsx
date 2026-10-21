import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PermissionsPage from "./page";

const perms = vi.hoisted(() => [
  { permission_id: 0, name: "Acceso total", output_mask: 15, card_reader_mask: 5, pin_reader_mask: 0, weekday_mask: 127, start_minute: 0, end_minute: 0, allow_rf: true },
  { permission_id: 1, name: "Solo PIN", output_mask: 1, card_reader_mask: 0, pin_reader_mask: 10, weekday_mask: 31, start_minute: 0, end_minute: 0, allow_rf: false },
]);
vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve(perms) }));

describe("PermissionsPage", () => {
  it("muestra las columnas Tarjeta, PIN y RF por permiso", async () => {
    render(<PermissionsPage />);
    const headers = (await screen.findAllByRole("columnheader")).map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Tarjeta", "PIN", "RF"]));
    expect(headers).not.toContain("Lectores");
    const col = (name: string) => headers.indexOf(name);
    const first = within((await screen.findByText("Acceso total")).closest("tr")!).getAllByRole("cell");
    expect(first[col("Tarjeta")]).toHaveTextContent("Reader1, Reader3");
    expect(first[col("PIN")]).toHaveTextContent("—");
    expect(first[col("RF")]).toHaveTextContent("Sí");
    const second = within(screen.getByText("Solo PIN").closest("tr")!).getAllByRole("cell");
    expect(second[col("Tarjeta")]).toHaveTextContent("—");
    expect(second[col("PIN")]).toHaveTextContent("Reader2, Reader4");
    expect(second[col("RF")]).toHaveTextContent("—");
  });
});
