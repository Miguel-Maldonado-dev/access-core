import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import QrImage from "./QrImage";

describe("QrImage", () => {
  it("muestra el número y el enlace de descarga", async () => {
    render(<QrImage code={912345678} />);
    expect(screen.getByText("912345678")).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "Descargar PNG" });
    expect(link).toHaveAttribute("download", "qr-912345678.png");
    expect(link.getAttribute("href")).toMatch(/^data:image\/png/);
    expect(await screen.findByAltText("Código QR 912345678")).toBeInTheDocument();
  });
});
