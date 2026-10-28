import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceApiError, deviceRoute } from "@/lib/device/http";
import { HttpError } from "@/lib/errors";

describe("deviceRoute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("traduce DeviceApiError a {code, message} con su estado", async () => {
    const res = await deviceRoute(async () => {
      throw new DeviceApiError(409, "not_active", "El panel no está activo.");
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ code: "not_active", message: "El panel no está activo." });
  });

  it("traduce un HttpError genérico a {code, message} con su estado (no a 500)", async () => {
    const casos: [number, string][] = [
      [400, "bad_request"],
      [403, "forbidden"],
      [404, "not_found"],
      [429, "too_many_requests"],
      [418, "http_error"],
    ];
    for (const [estado, codigo] of casos) {
      const res = await deviceRoute(async () => {
        throw new HttpError(estado, "Mensaje en español.");
      });
      expect(res.status).toBe(estado);
      expect(await res.json()).toEqual({ code: codigo, message: "Mensaje en español." });
    }
  });

  it("cualquier otro error responde 500 internal_error sin detalles", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await deviceRoute(async () => {
      throw new Error("detalle interno");
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "internal_error", message: "Error interno del servidor." });
    expect(consola).toHaveBeenCalledOnce();
  });
});
