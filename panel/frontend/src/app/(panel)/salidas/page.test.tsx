import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import OutputsPage from "./page";

const outputs = vi.hoisted(() => [
  { output_id: 0, duration_ms: 3000, reader_mask: 3, enabled: true, alias: "Pluma vehicular" },
  { output_id: 1, duration_ms: 3000, reader_mask: 12, enabled: true, alias: "" },
]);
vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve(outputs) }));

describe("OutputsPage", () => {
  it("muestra el alias de cada salida", async () => {
    render(<OutputsPage />);
    const form = await screen.findByRole("form", { name: "Relay1" });
    expect(form).toHaveTextContent("Pluma vehicular");
    expect(screen.getAllByLabelText("Alias").map((i) => (i as HTMLInputElement).value)).toEqual(["Pluma vehicular", ""]);
  });
});
