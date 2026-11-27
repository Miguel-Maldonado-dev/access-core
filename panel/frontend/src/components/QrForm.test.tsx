import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QrForm from "./QrForm";
import type { Holder } from "@/lib/types";

const holders: Holder[] = [
  { holder_id: 1, kind: "persona" as const, name: "Ana", department: "", address: "", notes: "", has_pin: false, permission_ids: [], card_count: 0, control_count: 0 },
];

function fill(from: string, until: string) {
  fireEvent.change(screen.getByLabelText("Desde"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: until } });
}

describe("QrForm", () => {
  it("rechaza un hasta anterior al desde", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<QrForm holders={holders} onSubmit={onSubmit} />);
    await user.selectOptions(screen.getByLabelText("Anfitrión"), "1");
    fill("2026-12-01T10:00", "2026-12-01T09:00");
    await user.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(screen.getByRole("alert")).toHaveTextContent("La vigencia debe terminar después de empezar.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("exige anfitrión y usos de 1 a 100", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<QrForm holders={holders} onSubmit={onSubmit} />);
    fill("2026-12-01T09:00", "2026-12-01T10:00");
    await user.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Elige un anfitrión.");
    await user.selectOptions(screen.getByLabelText("Anfitrión"), "1");
    fireEvent.change(screen.getByLabelText("Usos por lector"), { target: { value: "101" } });
    await user.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Los usos deben estar entre 1 y 100.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("envía la vigencia en ISO UTC desde hora de México", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<QrForm holders={holders} onSubmit={onSubmit} />);
    await user.selectOptions(screen.getByLabelText("Anfitrión"), "1");
    await user.type(screen.getByLabelText("Etiqueta"), "Plomero");
    fill("2026-12-01T09:00", "2026-12-01T18:00");
    await user.click(screen.getByRole("button", { name: "Crear QR" }));
    expect(onSubmit).toHaveBeenCalledWith({
      holder_id: 1, label: "Plomero", valid_from: "2026-12-01T15:00:00.000Z", valid_until: "2026-12-02T00:00:00.000Z", max_uses: 1,
    });
  });
});
