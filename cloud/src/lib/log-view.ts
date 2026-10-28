import { readerLabel } from "@/lib/profile-view";

/**
 * Piezas compartidas por servidor y navegador para la pestaña Logs: etiquetas, filtros de
 * la URL y fechas. Las etiquetas (orígenes, motivos, medio, fecha) vienen de
 * `panel/frontend/src/lib/format.ts` del panel local: son proyectos distintos y no se
 * puede importar de uno a otro, así que se copian aquí; si cambian allá, cámbialas también.
 */

export const LOG_PAGE_SIZE = 50;

/** Fila de `access_logs` con el código del panel y el alias de la salida ya resueltos. */
export interface LogRow {
  id: number;
  ts: string;
  panel_id: string;
  panel_code: string;
  allowed: boolean;
  source: number;
  reason: number;
  holder_id: string | null;
  holder_name: string | null;
  holder_kind: "persona" | "domicilio" | null;
  credential_label: string | null;
  control_id: string | null;
  code: number | null;
  device_id: number | null;
  /** Índice de salida del panel (0–3); el contrato lo llama `output_id`. */
  output_index: number | null;
  output_alias: string | null;
}

// Copiado de panel/frontend/src/lib/format.ts
const REASONS: Record<number, string> = {
  0: "Permitido",
  1: "Tarjeta desconocida",
  2: "Sin salida",
  3: "Sin permiso",
  4: "Error UART",
  5: "Control desconocido",
  6: "Botón sin salida",
  7: "Botón de salida",
  8: "PIN desconocido",
  9: "PIN no permitido",
  10: "PIN bloqueado",
};

// Copiado de panel/frontend/src/lib/format.ts
const SOURCES: Record<number, string> = {
  0: "Tarjeta",
  1: "Control RF",
  2: "Botón de salida",
  3: "PIN",
};

export const SOURCE_OPTIONS = [0, 1, 2, 3] as const;

export const reasonLabel = (reason: number) => REASONS[reason] ?? `Motivo ${reason}`;
export const sourceLabel = (source: number) => SOURCES[source] ?? `Origen ${source}`;

export function holderKindLabel(kind: "persona" | "domicilio"): string {
  return kind === "persona" ? "Persona" : "Domicilio";
}

/** Salida: su alias o, sin alias, S1–S4 (como la tabla de permisos); sin salida, un guion. */
export function outputLabel(index: number | null, alias?: string | null): string {
  if (index === null) return "-";
  const nombre = alias?.trim();
  return nombre ? nombre : `S${index + 1}`;
}

type MediumInput = Pick<LogRow, "source" | "reason" | "credential_label" | "control_id" | "device_id">;

/** Medio de acceso (adaptado de `mediumLabel` del panel local; los lectores se nombran L1–L4 como en Perfiles). */
export function mediumLabel(log: MediumInput): string {
  const device = log.device_id;
  if (log.source === 0) {
    const lector = device === null ? "" : ` · ${readerLabel(device)}`;
    return `${log.credential_label ?? "Tarjeta"}${lector}`;
  }
  if (log.source === 1) {
    if (log.reason === 5) return "Control no registrado";
    const nombre = log.credential_label ?? (log.control_id !== null ? "Control" : "Control borrado");
    return device === null ? nombre : `${nombre} · Botón ${device + 1}`;
  }
  if (log.source === 3) {
    return device === null ? "PIN" : `PIN · ${readerLabel(device)}`;
  }
  return device === null ? "Botón de salida" : `Botón de salida ${device + 1}`;
}

const ZONA = "America/Mexico_City";

const fechaHora = new Intl.DateTimeFormat("es-MX", {
  timeZone: ZONA,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Fecha y hora de México, como el panel local. */
export function formatDateTime(iso: string): string {
  return fechaHora.format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Filtros en la URL
// ---------------------------------------------------------------------------

export interface LogFilters {
  /** Día local de México, AAAA-MM-DD (inclusive). */
  from?: string;
  to?: string;
  panelId?: string;
  holderId?: string;
  allowed?: boolean;
  source?: number;
  page: number;
}

type Consulta = Record<string, string | string[] | undefined>;

const primero = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function diaValido(texto: string | undefined): string | undefined {
  const m = texto ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto) : null;
  if (!m) return undefined;
  const [y, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(y, mes - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === mes - 1 && f.getUTCDate() === d ? texto : undefined;
}

/** Filtros de los parámetros de la URL; lo inválido se ignora en vez de fallar. */
export function parseLogFilters(consulta: Consulta): LogFilters {
  const filtros: LogFilters = { page: 1 };
  const desde = diaValido(primero(consulta.desde));
  if (desde) filtros.from = desde;
  const hasta = diaValido(primero(consulta.hasta));
  if (hasta) filtros.to = hasta;
  const panel = primero(consulta.panel);
  if (panel && UUID.test(panel)) filtros.panelId = panel;
  const titular = primero(consulta.titular);
  if (titular && UUID.test(titular)) filtros.holderId = titular;
  const resultado = primero(consulta.resultado);
  if (resultado === "permitido") filtros.allowed = true;
  if (resultado === "denegado") filtros.allowed = false;
  const origen = primero(consulta.origen);
  if (origen !== undefined && /^\d+$/.test(origen) && (SOURCE_OPTIONS as readonly number[]).includes(Number(origen))) {
    filtros.source = Number(origen);
  }
  const pagina = primero(consulta.pagina);
  if (pagina !== undefined && /^\d+$/.test(pagina) && Number(pagina) >= 1 && Number.isSafeInteger(Number(pagina))) {
    filtros.page = Number(pagina);
  }
  return filtros;
}

/** URL de una página de logs con los filtros activos (compartible); la página 1 no lleva `pagina`. */
export function logsHref(base: string, filtros: LogFilters, page = 1): string {
  const q = new URLSearchParams();
  if (filtros.from) q.set("desde", filtros.from);
  if (filtros.to) q.set("hasta", filtros.to);
  if (filtros.panelId) q.set("panel", filtros.panelId);
  if (filtros.holderId) q.set("titular", filtros.holderId);
  if (filtros.allowed !== undefined) q.set("resultado", filtros.allowed ? "permitido" : "denegado");
  if (filtros.source !== undefined) q.set("origen", String(filtros.source));
  if (page > 1) q.set("pagina", String(page));
  const texto = q.toString();
  return texto ? `${base}?${texto}` : base;
}

// ---------------------------------------------------------------------------
// Día local de México → UTC
// ---------------------------------------------------------------------------

/** Diferencia (ms) entre la hora de México y UTC en ese instante (negativa al oeste de UTC). */
function desfaseMexico(instante: number): number {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ZONA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instante))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute, +partes.second);
  return local - Math.floor(instante / 1000) * 1000;
}

/** Instante UTC (ISO) en que empieza el día `AAAA-MM-DD` en México; respeta el horario de verano de años anteriores. */
export function localDayStartUtc(dia: string): string {
  const [y, m, d] = dia.split("-").map(Number);
  const nominal = Date.UTC(y, m - 1, d);
  // Dos pasadas: el desfase se mide en el instante resultante, por si cruza un cambio de horario.
  let instante = nominal - desfaseMexico(nominal);
  instante = nominal - desfaseMexico(instante);
  return new Date(instante).toISOString();
}

/** Día siguiente (AAAA-MM-DD) de un día válido. */
export function nextDay(dia: string): string {
  const [y, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
