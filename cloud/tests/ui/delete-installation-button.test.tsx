// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeleteInstallationButton from "@/components/installations/DeleteInstallationButton";
import type { ActionResult } from "@/lib/actions";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

afterEach(() => {
  cleanup();
  replace.mockClear();
});

const envio = () =>
  screen
    .getAllByRole("button", { name: "Eliminar instalación" })
    .find((b) => (b as HTMLButtonElement).type === "submit") as HTMLButtonElement;

describe("DeleteInstallationButton", () => {
  // jsdom no implementa showModal/close del <dialog>.
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  });

  it("un técnico no ve la zona de peligro", () => {
    render(<DeleteInstallationButton canDelete={false} installationName="Villa Real" listPath="/t/x/installations" onDelete={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Eliminar instalación" })).toBeNull();
  });

  it("confirmar sigue deshabilitado hasta que el texto coincide y muestra el aviso", () => {
    render(<DeleteInstallationButton canDelete installationName="Villa Real" listPath="/t/x/installations" onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar instalación" }));
    expect(screen.getByText("Escribe el nombre de la instalación para confirmar.")).toBeTruthy();
    expect(
      screen.getByText(
        "Se borrarán todos los datos de la instalación en la nube. Los paneles se desvinculan y siguen funcionando con sus datos locales.",
      ),
    ).toBeTruthy();
    expect(envio().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Villa" } });
    expect(envio().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " Villa Real " } });
    expect(envio().disabled).toBe(false);
  });

  it("al confirmar elimina y regresa a la lista", async () => {
    const onDelete = vi.fn(async (): Promise<ActionResult> => ({ ok: true, data: undefined }));
    render(<DeleteInstallationButton canDelete installationName="Villa Real" listPath="/t/x/installations" onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar instalación" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Villa Real" } });
    fireEvent.click(envio());
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/t/x/installations"));
    expect(onDelete).toHaveBeenCalledWith("Villa Real");
  });

  it("muestra el error del servidor y no redirige", async () => {
    const onDelete = vi.fn(async (): Promise<ActionResult> => ({ ok: false, status: 403, error: "No tienes permiso." }));
    render(<DeleteInstallationButton canDelete installationName="Villa Real" listPath="/t/x/installations" onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar instalación" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Villa Real" } });
    fireEvent.click(envio());
    expect(await screen.findByText("No tienes permiso.")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
