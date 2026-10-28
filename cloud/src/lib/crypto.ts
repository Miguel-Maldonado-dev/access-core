import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALFABETO_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Lee una clave de 32 bytes en base64 del entorno (en cada llamada, sin caché). */
function leerClave(nombre: "PIN_ENC_KEY" | "PIN_LOOKUP_KEY"): Buffer {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(`Falta la variable de entorno ${nombre}.`);
  }
  const clave = Buffer.from(valor, "base64");
  if (clave.length !== 32) {
    throw new Error(`${nombre} debe ser base64 de exactamente 32 bytes.`);
  }
  return clave;
}

/** Cifra un PIN con AES-256-GCM. Devuelve base64(iv12|tag16|ciphertext). */
export function encryptPin(pin: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", leerClave("PIN_ENC_KEY"), iv);
  const cifrado = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), cifrado]).toString("base64");
}

/** Descifra el resultado de `encryptPin`. Lanza error si el blob es inválido o fue alterado. */
export function decryptPin(blob: string): string {
  const clave = leerClave("PIN_ENC_KEY");
  const datos = Buffer.from(blob, "base64");
  // base64 inválido o truncado: Buffer lo tolera, así que se valida la forma.
  if (datos.length <= IV_BYTES + TAG_BYTES || datos.toString("base64") !== blob) {
    throw new Error("El PIN cifrado no es válido.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", clave, datos.subarray(0, IV_BYTES));
    decipher.setAuthTag(datos.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(datos.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("El PIN cifrado no es válido o fue alterado.");
  }
}

/** HMAC-SHA256(PIN_LOOKUP_KEY, installationId + ":" + pin) en hexadecimal. */
export function pinLookup(installationId: string, pin: string): string {
  return createHmac("sha256", leerClave("PIN_LOOKUP_KEY"))
    .update(`${installationId}:${pin}`)
    .digest("hex");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * Compara dos hashes en hexadecimal en tiempo constante (sobre sus bytes).
 * Falso si alguno no es hexadecimal válido o si sus longitudes difieren.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (!HEX_RE.test(a) || !HEX_RE.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Cadena aleatoria de `n` caracteres del alfabeto Crockford. Sin sesgo de módulo:
 * 32 divide 256, así que `byte & 31` es uniforme sobre los 32 caracteres.
 */
export function randomBase32(n: number): string {
  const bytes = randomBytes(n);
  let salida = "";
  for (const b of bytes) salida += ALFABETO_CROCKFORD[b & 31];
  return salida;
}

/** Token de dispositivo: 32 bytes aleatorios en base64url (sin relleno). */
export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}
