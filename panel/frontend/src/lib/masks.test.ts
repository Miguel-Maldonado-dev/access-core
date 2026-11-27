import { describe, expect, it } from "vitest";
import { fromMask, readerMethods, toMask } from "./masks";

describe("masks", () => {
  it("arma la máscara", () => {
    expect(toMask([true, false, true, false])).toBe(5);
    expect(toMask([])).toBe(0);
  });
  it("descompone la máscara", () => {
    expect(fromMask(12, 4)).toEqual([false, false, true, true]);
    expect(fromMask(31, 7)).toEqual([true, true, true, true, true, false, false]);
  });
  it("abrevia los métodos por lector", () => {
    expect(readerMethods(5, 0, 0)).toBe("L1 T, L3 T");
    expect(readerMethods(0, 10, 2)).toBe("L2 P·Q, L4 P");
    expect(readerMethods(1, 1, 1)).toBe("L1 T·P·Q");
    expect(readerMethods(0, 0, 0)).toBe("");
  });
});
