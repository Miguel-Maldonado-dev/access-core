import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptPin,
  encryptPin,
  newDeviceToken,
  pinLookup,
  randomBase32,
  safeEqualHex,
  sha256Hex,
} from "@/lib/crypto";

const clave = () => randomBytes(32).toString("base64");

describe("crypto", () => {
  const original = {
    enc: process.env.PIN_ENC_KEY,
    lookup: process.env.PIN_LOOKUP_KEY,
  };

  beforeEach(() => {
    process.env.PIN_ENC_KEY = clave();
    process.env.PIN_LOOKUP_KEY = clave();
  });

  afterEach(() => {
    for (const [k, v] of [
      ["PIN_ENC_KEY", original.enc],
      ["PIN_LOOKUP_KEY", original.lookup],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("descifra lo que cifra", () => {
    expect(decryptPin(encryptPin("0123"))).toBe("0123");
  });

  it("dos cifrados del mismo PIN difieren", () => {
    expect(encryptPin("0123")).not.toBe(encryptPin("0123"));
  });

  it("el blob tiene formato iv12|tag16|ciphertext en base64", () => {
    const raw = Buffer.from(encryptPin("0123"), "base64");
    expect(raw.length).toBe(12 + 16 + 4);
  });

  it("alterar un byte hace fallar el descifrado sin revelar el PIN", () => {
    const raw = Buffer.from(encryptPin("987654"), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptPin(raw.toString("base64"))).toThrow(/PIN/);
    try {
      decryptPin(raw.toString("base64"));
    } catch (e) {
      expect((e as Error).message).not.toContain("987654");
    }
  });

  it("un blob truncado o con base64 inválido lanza error", () => {
    const blob = encryptPin("0123");
    expect(() => decryptPin(blob.slice(0, 10))).toThrow();
    expect(() => decryptPin("")).toThrow();
    expect(() => decryptPin("!!!no es base64!!!")).toThrow();
  });

  it("pinLookup es estable y difiere entre instalaciones y PIN", () => {
    const a = pinLookup("inst-a", "0123");
    expect(pinLookup("inst-a", "0123")).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(pinLookup("inst-b", "0123")).not.toBe(a);
    expect(pinLookup("inst-a", "0124")).not.toBe(a);
  });

  it("falta de clave lanza error sin incluir valores", () => {
    delete process.env.PIN_ENC_KEY;
    expect(() => encryptPin("0123")).toThrow(/PIN_ENC_KEY/);
    delete process.env.PIN_LOOKUP_KEY;
    expect(() => pinLookup("i", "0123")).toThrow(/PIN_LOOKUP_KEY/);
  });

  it("clave de longitud incorrecta lanza error sin incluir la clave", () => {
    const corta = randomBytes(16).toString("base64");
    process.env.PIN_ENC_KEY = corta;
    try {
      encryptPin("0123");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/32 bytes/);
      expect((e as Error).message).not.toContain(corta);
    }
    process.env.PIN_LOOKUP_KEY = corta;
    expect(() => pinLookup("i", "0123")).toThrow(/32 bytes/);
  });

  it("sha256Hex coincide con el vector conocido", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("randomBase32 usa solo el alfabeto Crockford", () => {
    const s = randomBase32(8);
    expect(s).toHaveLength(8);
    expect(s).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(randomBase32(0)).toBe("");
    expect(randomBase32(500)).toMatch(/^[0-9A-HJKMNP-TV-Z]{500}$/);
  });

  it("newDeviceToken es base64url sin relleno de 32 bytes", () => {
    const t = newDeviceToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(newDeviceToken()).not.toBe(t);
  });

  it("safeEqualHex compara hashes hexadecimales sin importar mayúsculas y rechaza formas distintas", () => {
    const h = sha256Hex("abc");
    expect(safeEqualHex(h, sha256Hex("abc"))).toBe(true);
    expect(safeEqualHex(h, h.toUpperCase())).toBe(true);
    expect(safeEqualHex(h, sha256Hex("abd"))).toBe(false);
    expect(safeEqualHex(h, h.slice(0, 62))).toBe(false);
    expect(safeEqualHex(h, `${h.slice(0, 62)}zz`)).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
  });
});
