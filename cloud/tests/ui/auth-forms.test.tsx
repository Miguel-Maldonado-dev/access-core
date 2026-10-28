// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmLinkForm from "@/components/auth/ConfirmLinkForm";

/**
 * /auth/confirm: abrir el enlace (GET) solo muestra el botón; el token se usa al enviar el
 * formulario (POST). Así un escáner de correo que sigue el enlace no lo consume.
 */
afterEach(() => cleanup());

describe("ConfirmLinkForm (/auth/confirm)", () => {
  it("con un enlace de recuperación muestra el botón Continuar y no usa el token al mostrarse", () => {
    const accion = vi.fn();
    render(<ConfirmLinkForm tokenHash="abc123" type="recovery" action={accion} />);
    expect(screen.getByRole("button", { name: "Continuar" })).toBeTruthy();
    expect(accion).not.toHaveBeenCalled();
  });

  it("con un enlace de recuperación cambia el título", () => {
    render(<ConfirmLinkForm tokenHash="abc123" type="recovery" action={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Restablece tu contraseña");
  });

  it("al pulsar Continuar envía el token y el tipo", async () => {
    const accion = vi.fn<(datos: FormData) => Promise<void>>(async () => {});
    render(<ConfirmLinkForm tokenHash="abc123" type="recovery" action={accion} />);
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(accion).toHaveBeenCalledTimes(1));
    const datos = accion.mock.calls[0][0];
    expect(datos.get("token_hash")).toBe("abc123");
    expect(datos.get("type")).toBe("recovery");
  });
});
