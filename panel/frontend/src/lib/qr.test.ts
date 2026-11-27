import { describe, expect, it } from "vitest";
import { qrDataUrl } from "./qr";

describe("qrDataUrl", () => {
  it("genera un PNG en data URL con el número", async () => {
    const url = await qrDataUrl(912345678);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });
});
