import { describe, expect, it } from "vitest";
import { fromMask, toMask } from "./masks";

describe("masks", () => {
  it("arma la máscara", () => {
    expect(toMask([true, false, true, false])).toBe(5);
    expect(toMask([])).toBe(0);
  });
  it("descompone la máscara", () => {
    expect(fromMask(12, 4)).toEqual([false, false, true, true]);
    expect(fromMask(31, 7)).toEqual([true, true, true, true, true, false, false]);
  });
});
