import "server-only";
import { randomInt } from "node:crypto";
import { autoria, type DataClient } from "@/lib/auth/guards";
import {
  esUuid,
  fetchAll,
  holderNames,
  isMissingParent,
  HOLDER_GONE,
  requireHolder,
  requireInstallationAccess,
} from "@/lib/access-data";
import { HttpError } from "@/lib/errors";

/**
 * Códigos QR (accesos temporales) de una instalación como el usuario de la sesión (RLS;
 * admin y técnico). Un QR no se edita: se crea y se revoca (borrado lógico). El código es
 * aleatorio dentro del rango del dígito de QR de la instalación; la base impone el tope de
 * vigentes (PT422, que PostgREST responde como 422) y que no repita un QR vivo ni una tarjeta (23505).
 */

export type QrStatus = "pending" | "active" | "expired";

export interface QrCodeRow {
  id: string;
  holder_id: string;
  holder_name: string;
  code: number;
  label: string;
  valid_from: string;
  valid_until: string;
  max_uses: number;
  status: QrStatus;
  created_at: string;
  origin: string;
}

export interface QrCodeInput {
  holder_id: string;
  label?: string;
  valid_from: string;
  valid_until: string;
  max_uses?: number;
}

export const QR_LABEL_MAX = 60;
export const QR_MAX_USES = 100;
/** Intentos de generar un código libre antes de rendirse (503). */
const INTENTOS_CODIGO = 20;
export const QR_CODE_UNAVAILABLE = "No se pudo generar un código de QR único.";

/** Rango de códigos de QR para el dígito D (como `private.qr_range` de la base). */
export function qrRange(digit: number): [number, number] {
  if (digit <= 3) return [digit * 1_000_000_000, digit * 1_000_000_000 + 999_999_999];
  if (digit === 4) return [4_000_000_000, 4_294_967_295];
  return [digit * 100_000_000, digit * 100_000_000 + 99_999_999];
}

/** Estado por la vigencia: aún no empieza, vigente o vencido. */
export function qrStatus(row: { valid_from: string; valid_until: string }, now: Date): QrStatus {
  const t = now.getTime();
  if (t < Date.parse(row.valid_from)) return "pending";
  if (t >= Date.parse(row.valid_until)) return "expired";
  return "active";
}

const COLUMNAS = "id, holder_id, code, label, valid_from, valid_until, max_uses, created_at, origin";
type Fila = Omit<QrCodeRow, "holder_name" | "status">;

const iso = (t: string) => new Date(t).toISOString();

function aRespuesta(f: Fila, nombres: Map<string, string>, ahora: Date): QrCodeRow {
  const fila = {
    id: f.id,
    holder_id: f.holder_id,
    holder_name: nombres.get(f.holder_id) ?? "",
    code: Number(f.code),
    label: f.label,
    valid_from: iso(f.valid_from),
    valid_until: iso(f.valid_until),
    max_uses: f.max_uses,
    created_at: iso(f.created_at),
    origin: f.origin,
  };
  return { ...fila, status: qrStatus(fila, ahora) };
}

/** Error de la base de los QR: PT422 (tope o rango) → 422 con su texto; el resto se relanza. */
function traducir(error: { code?: string; message?: string }): never {
  if (error.code === "PT422") throw new HttpError(422, error.message ?? "Operación no permitida.");
  if (isMissingParent(error)) throw new HttpError(409, HOLDER_GONE);
  throw error;
}

function parseFecha(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || Number.isNaN(Date.parse(valor))) {
    throw new HttpError(400, `La fecha ${campo} no es válida.`);
  }
  return iso(valor);
}

function parseLabel(valor: unknown): string {
  if (valor === undefined || valor === null) return "";
  if (typeof valor !== "string") throw new HttpError(400, "La etiqueta no es válida.");
  const limpio = valor.trim();
  if (limpio.length > QR_LABEL_MAX) throw new HttpError(400, `La etiqueta admite hasta ${QR_LABEL_MAX} caracteres.`);
  if (limpio.includes("\u0000")) throw new HttpError(400, "La etiqueta contiene caracteres no válidos.");
  return limpio;
}

function parseUsos(valor: unknown): number {
  if (valor === undefined || valor === null) return 1;
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 1 || valor > QR_MAX_USES) {
    throw new HttpError(400, `Los usos deben ser de 1 a ${QR_MAX_USES}.`);
  }
  return valor;
}

/** QR vivos con el nombre del anfitrión, más nuevos primero; filtra por titular o estado. */
export async function listQrCodesAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  filtro: { holderId?: string; status?: QrStatus } = {},
): Promise<QrCodeRow[]> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  if (filtro.holderId !== undefined && !esUuid(filtro.holderId)) return [];
  const [filas, nombres] = await Promise.all([
    fetchAll<Fila>((desde, hasta) => {
      let q = cliente.from("qr_codes").select(COLUMNAS).eq("installation_id", installationId).is("deleted_at", null);
      if (filtro.holderId !== undefined) q = q.eq("holder_id", filtro.holderId);
      return q.order("created_at", { ascending: false }).order("id").range(desde, hasta);
    }),
    holderNames(cliente, installationId),
  ]);
  const ahora = new Date();
  const todos = filas.map((f) => aRespuesta(f, nombres, ahora));
  return filtro.status === undefined ? todos : todos.filter((q) => q.status === filtro.status);
}

/** Un QR vivo por id; 404 si no existe o es de otra instalación. */
export async function getQrCodeAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  qrId: string,
): Promise<QrCodeRow> {
  const { supabase: cliente } = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const noExiste = new HttpError(404, "El QR no existe.");
  if (!esUuid(qrId)) throw noExiste;
  const { data, error } = await cliente
    .from("qr_codes")
    .select(COLUMNAS)
    .eq("id", qrId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .maybeSingle<Fila>();
  if (error) throw error;
  if (!data) throw noExiste;
  const nombres = await holderNames(cliente, installationId, [data.holder_id]);
  return aRespuesta(data, nombres, new Date());
}

/**
 * Crea un QR con código aleatorio (generador criptográfico) en el rango del dígito de la
 * instalación. Si el código choca con un QR vivo o una tarjeta (23505), prueba otro hasta
 * 20 veces y luego responde 503. 422 si se rebasa el tope de vigentes.
 */
export async function createQrCodeAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  entrada: QrCodeInput,
): Promise<{ id: string }> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const holderId = await requireHolder(cliente, installationId, entrada?.holder_id);
  const label = parseLabel(entrada.label);
  const desde = parseFecha(entrada.valid_from, "de inicio");
  const hasta = parseFecha(entrada.valid_until, "de fin");
  if (Date.parse(hasta) <= Date.parse(desde)) {
    throw new HttpError(422, "La vigencia debe terminar después de empezar.");
  }
  const usos = parseUsos(entrada.max_uses);

  const { data: inst, error: errorInst } = await cliente
    .from("installations")
    .select("qr_digit")
    .eq("id", installationId)
    .single<{ qr_digit: number }>();
  if (errorInst) throw errorInst;
  const [lo, hi] = qrRange(inst.qr_digit);

  for (let intento = 0; intento < INTENTOS_CODIGO; intento++) {
    const { data, error } = await cliente
      .from("qr_codes")
      .insert({
        installation_id: installationId,
        holder_id: holderId,
        code: randomInt(lo, hi + 1),
        label,
        valid_from: desde,
        valid_until: hasta,
        max_uses: usos,
        ...autoria(acceso),
      })
      .select("id")
      .single<{ id: string }>();
    if (!error) return data;
    // El único índice único de la tabla (además del id) es el del código vivo.
    if (error.code === "23505") continue;
    traducir(error);
  }
  throw new HttpError(503, QR_CODE_UNAVAILABLE);
}

/** Revoca un QR (borrado lógico; libera su código). */
export async function deleteQrCodeAs(
  supabase: DataClient,
  tenantId: string,
  installationId: string,
  qrId: string,
): Promise<void> {
  const acceso = await requireInstallationAccess(supabase, tenantId, installationId, "tecnico");
  const cliente = acceso.supabase;
  const noExiste = new HttpError(404, "El QR no existe.");
  if (!esUuid(qrId)) throw noExiste;
  const { data, error } = await cliente
    .from("qr_codes")
    .update({ deleted_at: new Date().toISOString(), ...autoria(acceso) })
    .eq("id", qrId)
    .eq("installation_id", installationId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw noExiste;
}
