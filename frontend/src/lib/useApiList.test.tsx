import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useApiList } from "./useApiList";

// Se usa una función simple (no vi.fn) para que las promesas rechazadas queden bajo control de la prueba.
const api = vi.hoisted(() => ({ impl: (path: string): Promise<unknown> => Promise.resolve([path]) }));
vi.mock("./api", () => ({ apiFetch: (path: string) => api.impl(path) }));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useApiList", () => {
  beforeEach(() => {
    api.impl = () => Promise.resolve([]);
  });

  it("una respuesta lenta anterior no pisa a la más nueva", async () => {
    const a = deferred<string[]>();
    const b = deferred<string[]>();
    api.impl = (p) => (p === "/a" ? a.promise : b.promise);
    const { result, rerender } = renderHook(({ path }) => useApiList<string>(path), { initialProps: { path: "/a" } });
    rerender({ path: "/b" });
    await act(async () => b.resolve(["B"]));
    await act(async () => a.resolve(["A"]));
    expect(result.current.items).toEqual(["B"]);
    expect(result.current.loaded).toBe(true);
  });

  it("reload vuelve a pedir la lista", async () => {
    const calls = [["1"], ["1", "2"]];
    api.impl = () => Promise.resolve(calls.shift());
    const { result } = renderHook(() => useApiList<string>("/x"));
    await act(async () => {});
    await act(async () => result.current.reload());
    expect(result.current.items).toEqual(["1", "2"]);
  });

  it("expone el mensaje de error", async () => {
    const d = deferred<string[]>();
    api.impl = () => d.promise;
    const { result } = renderHook(() => useApiList<string>("/x"));
    await act(async () => d.reject(new Error("Fallo")));
    expect(result.current.error).toBe("Fallo");
  });
});
