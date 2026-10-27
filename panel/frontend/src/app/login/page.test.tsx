import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage from "./page";

describe("inicio de sesión", () => {
  const assign = vi.fn();

  beforeEach(() => {
    assign.mockReset();
    vi.stubGlobal("location", { assign, pathname: "/login/" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function fill() {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText("Usuario"), "admin");
    await user.type(screen.getByLabelText("Contraseña"), "secreto");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
  }

  it("envía las credenciales y entra a Titulares", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await fill();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("/api/login");
    expect(spy.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(spy.mock.calls[0][1]?.body as string)).toEqual({ username: "admin", password: "secreto" });
    expect(assign).toHaveBeenCalledWith("/titulares/");
  });

  it("muestra el error con 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Usuario o contraseña incorrectos" }), { status: 401 }),
    );
    await fill();
    expect(await screen.findByText("Usuario o contraseña incorrectos")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
