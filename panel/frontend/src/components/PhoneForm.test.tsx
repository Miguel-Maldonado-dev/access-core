import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PhoneForm from "./PhoneForm";
import type { Holder } from "@/lib/types";

const holders = [
  { holder_id: 1, name: "Casa 12" },
  { holder_id: 2, name: "Casa 14" },
] as Holder[];

describe("PhoneForm", () => {
  it("rechaza un número que no tiene 10 dígitos", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PhoneForm holders={holders} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Número"), "551234");
    await user.selectOptions(screen.getByLabelText("Titular"), "1");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("El número debe tener 10 dígitos.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("pide elegir un titular", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PhoneForm holders={holders} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Número"), "5512345678");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Elige un titular.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("envía el número sin espacios ni guiones", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PhoneForm holders={holders} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Número"), "55 1234-5678");
    await user.selectOptions(screen.getByLabelText("Titular"), "2");
    await user.type(screen.getByLabelText("Descripción"), " Celular ");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onSubmit).toHaveBeenCalledWith({ holder_id: 2, number: "5512345678", description: "Celular" });
  });

  it("refleja el teléfono editado", () => {
    const phone = { phone_id: 3, holder_id: 2, holder_name: "Casa 14", number: "5512345678", description: "Papá" };
    render(<PhoneForm phone={phone} holders={holders} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Número")).toHaveValue("5512345678");
    expect(screen.getByLabelText("Titular")).toHaveValue("2");
    expect(screen.getByLabelText("Descripción")).toHaveValue("Papá");
  });
});
