import { describe, expect, it } from "vitest";
import { parseCode } from "./codes";

const MSG = "Usa solo números (0 a 4294967295).";

describe("parseCode", () => {
  it("acepta decimales", () => {
    expect(parseCode("8518512")).toBe(8518512);
    expect(parseCode("4294967295")).toBe(4294967295);
  });
  it.each(["0x10", "4294967296", "", "abc", "-1", "1.5"])("rechaza %j", (text) => {
    expect(() => parseCode(text)).toThrow(MSG);
  });
});
