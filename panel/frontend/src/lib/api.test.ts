import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./api";

function reply(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe("apiFetch", () => {
  const assign = vi.fn();

  beforeEach(() => {
    assign.mockReset();
    vi.stubGlobal("location", { assign, pathname: "/titulares/" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("un 401 lanza ApiError y lleva a /login/", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(401, { detail: "No autenticado" }));
    const err = (await apiFetch("/api/holders").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(assign).toHaveBeenCalledWith("/login/");
  });

  it("un 409 lanza el detalle como mensaje", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(409, { detail: "Ya existe el permiso 3." }));
    await expect(apiFetch("/api/permissions", { method: "POST", body: "{}" })).rejects.toThrow("Ya existe el permiso 3.");
  });

  it("un 204 regresa undefined", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(204));
    await expect(apiFetch("/api/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("envía cookies y Content-Type solo con cuerpo", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => reply(200, { ok: 1 }));
    await apiFetch("/api/x", { method: "POST", body: "{}" });
    await apiFetch("/api/y");
    const first = spy.mock.calls[0][1]!;
    const second = spy.mock.calls[1][1]!;
    expect(first.credentials).toBe("include");
    expect(new Headers(first.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(second.headers).has("Content-Type")).toBe(false);
  });
});
