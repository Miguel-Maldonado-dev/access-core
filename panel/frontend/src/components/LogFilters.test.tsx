import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LogFilters from "./LogFilters";

describe("LogFilters", () => {
  it("ofrece el origen Remota y filtra por el 4", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<LogFilters value={{}} holders={[]} onChange={onChange} />);
    const origin = screen.getByLabelText("Origen");
    const options = within(origin).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Todos", "Tarjeta", "Control RF", "Botón de salida", "PIN", "Remota", "Prueba"]);
    await user.selectOptions(origin, "Remota");
    expect(onChange).toHaveBeenCalledWith({ source: 4 });
  });
});
