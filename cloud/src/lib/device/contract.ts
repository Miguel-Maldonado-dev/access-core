import { z } from "zod";

/**
 * Contrato de sincronización de la API de dispositivos (`/api/device/v1`).
 * `data` usa los nombres de las tablas y columnas LOCALES del panel; las referencias
 * entre registros van por UUID (en minúsculas). Los únicos valores que no son UUID son
 * `permission_id` (0..31, el `local_permission_id` del perfil) y `output_id` (0..3, el
 * `output_index` de la salida).
 */

/** Máximo de logs por lote de `POST /logs`. */
export const LOG_BATCH = 500;

/**
 * Tamaño máximo de una página de `GET /changes` (y de un lote de `POST /changes`). En
 * `GET /changes`, `limit` cuenta cambios de origen: `changes` puede traer más entradas
 * (el control auxiliar que precede a un botón, o el que sigue a su `delete`).
 */
export const CHANGES_PAGE = 500;

/** Tablas replicadas, con los nombres locales del panel. */
export const TABLES = [
  "holders",
  "cards",
  "controls",
  "control_buttons",
  "permissions",
  "holder_permissions",
  "outputs",
  "phones",
  "call_settings",
] as const;

/** Tablas que solo conoce un panel con el esquema local 8 o mayor (`X-Acc-Schema: 8`). */
export const SCHEMA8_TABLES: ReadonlySet<TableName> = new Set(["phones", "call_settings"]);

/** Tablas que recibe un panel con ese esquema local. */
export function tablesForSchema(schema: number): TableName[] {
  return TABLES.filter((t) => schema >= 8 || !SCHEMA8_TABLES.has(t));
}

export type TableName = (typeof TABLES)[number];

export const tableNameSchema = z.enum(TABLES);

/** UUID en minúsculas, como los genera Postgres y como viajan en el contrato. */
export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Mensaje del rechazo del carácter NUL (lo muestra `readJsonBody` en el 400). */
export const NUL_MESSAGE = "El texto no puede contener el carácter NUL (\\u0000).";

/**
 * Texto que Postgres puede guardar: rechaza `\u0000`, que pasa por JSON y zod pero
 * Postgres no admite en `text` ni en `jsonb` (22P05). Sin esto un lote quedaría atascado.
 */
export const texto = z.string().refine((s) => !s.includes("\u0000"), { message: NUL_MESSAGE });

const entero = (min: number, max: number) => z.int().min(min).max(max);
const mascara4 = entero(0, 15);
const codigo32 = entero(0, 4294967295);
const minutoDelDia = entero(0, 1439);

/** Forma de `data` de cada tabla. Estricta: una clave de más es un error. */
export const dataSchemas = {
  holders: z.strictObject({
    kind: z.enum(["persona", "domicilio"]),
    // Como la CHECK local `length(trim(name)) > 0`: el trim() de SQLite (y el de Postgres)
    // solo quita espacios, no tabuladores ni saltos de línea como el de JS.
    name: texto.regex(/[^ ]/),
    department: texto,
    address: texto,
    notes: texto,
    pin: texto.regex(/^[0-9]{4,6}$/).nullable(),
  }),
  cards: z.strictObject({
    card_code: codigo32,
    holder_id: uuidSchema,
    description: texto,
  }),
  controls: z.strictObject({
    holder_id: uuidSchema,
    description: texto,
  }),
  control_buttons: z.strictObject({
    control_id: uuidSchema,
    button: entero(0, 3),
    rf_code: codigo32,
    output_id: entero(0, 3).nullable(),
  }),
  permissions: z.strictObject({
    permission_id: entero(0, 31),
    name: texto,
    output_mask: mascara4,
    card_reader_mask: mascara4,
    pin_reader_mask: mascara4,
    allow_rf: z.boolean(),
    // Opcional: un panel v6 no lo envía (la nube conserva su valor). La nube siempre lo proyecta.
    allow_remote: z.boolean().optional(),
    // Opcional: un panel v7 no lo envía (la nube conserva su valor). Solo se proyecta a paneles v8.
    allow_call: z.boolean().optional(),
    weekday_mask: entero(0, 127),
    start_minute: minutoDelDia,
    end_minute: minutoDelDia,
  }),
  holder_permissions: z.strictObject({
    holder_id: uuidSchema,
    permission_id: entero(0, 31),
  }),
  outputs: z.strictObject({
    output_id: entero(0, 3),
    alias: texto,
    duration_ms: entero(0, 65535),
    reader_mask: mascara4,
    enabled: z.boolean(),
  }),
  phones: z.strictObject({
    holder_id: uuidSchema,
    number: z.string().regex(/^[0-9]{10}$/),
    description: texto,
  }),
  // `output_id` es el `output_index` de la salida de "Una salida". La salida predeterminada
  // del menú debe estar entre las del menú (CHECK de panel_call_settings): se valida aquí
  // para que el lote dé 400 y no un error de la base.
  call_settings: z
    .strictObject({
      enabled: z.boolean(),
      mode: z.enum(["single", "menu"]),
      output_id: entero(0, 3),
      menu_mask: mascara4,
      default_output: entero(0, 3).nullable(),
      call_limit_per_minute: entero(1, 20),
    })
    .refine((d) => d.default_output === null || ((d.menu_mask >> d.default_output) & 1) === 1, {
      message: "La salida predeterminada debe estar entre las salidas del menú.",
      path: ["default_output"],
    }),
} satisfies Record<TableName, z.ZodType>;

export type TableData = { [T in TableName]: z.infer<(typeof dataSchemas)[T]> };
export type HolderData = TableData["holders"];
export type CardData = TableData["cards"];
export type ControlData = TableData["controls"];
export type ControlButtonData = TableData["control_buttons"];
export type PermissionData = TableData["permissions"];
export type HolderPermissionData = TableData["holder_permissions"];
export type OutputData = TableData["outputs"];
export type PhoneData = TableData["phones"];
export type CallSettingsData = TableData["call_settings"];

/** Un registro de una tabla en la forma del contrato (snapshot, `current`, checksum). */
export interface ContractRow<T extends TableName = TableName> {
  id: string;
  data: TableData[T];
}

/** Un cambio de `GET /changes`. `delete` lleva solo `id` y `revision`, sin `data`. */
export type ChangeItem =
  | { [T in TableName]: { table: T; op: "upsert"; id: string; revision: number; data: TableData[T] } }[TableName]
  | { table: TableName; op: "delete"; id: string; revision: number };

/** Respuesta de `GET /changes?since=R&limit=N`. */
export interface PullResponse {
  /** Revisión hasta la que llega esta respuesta: el siguiente `since`. */
  revision: number;
  has_more: boolean;
  confirm_deletions: boolean;
  /** `installations.logs_cleared_at` en ISO (con `Z`), o nulo si nunca se borraron logs. */
  logs_cleared_at: string | null;
  /** Ordenados por `revision` ascendente. */
  changes: ChangeItem[];
}

/** Respuesta de `GET /checksums`. */
export interface ChecksumsResponse {
  revision: number;
  confirm_deletions: boolean;
  /** Solo las tablas que conoce el panel (sin `phones` ni `call_settings` para un panel v7). */
  tables: Partial<Record<TableName, string>>;
}

/** Respuesta de `GET /snapshot?table=T`. */
export interface SnapshotResponse<T extends TableName = TableName> {
  revision: number;
  rows: ContractRow<T>[];
}

/** Identificador de un cambio del panel (el agente usa 32 caracteres hexadecimales). */
const changeIdSchema = texto.min(1).max(64);
/** Fecha ISO-8601 con zona (`Z` o desfase); el contrato la manda en UTC con milisegundos. */
const fechaIsoSchema = z.iso.datetime({ offset: true });

function upsertSchema<T extends TableName>(table: T) {
  return z.object({
    change_id: changeIdSchema,
    table: z.literal(table),
    op: z.literal("upsert"),
    id: uuidSchema,
    updated_at: fechaIsoSchema,
    data: dataSchemas[table],
  });
}

/**
 * Un cambio de `POST /changes`: `upsert` exige `data` válida para su tabla; `delete`
 * no la lleva (si viene, se ignora).
 */
export const pushItemSchema = z.discriminatedUnion("op", [
  z.discriminatedUnion("table", [
    upsertSchema("holders"),
    upsertSchema("cards"),
    upsertSchema("controls"),
    upsertSchema("control_buttons"),
    upsertSchema("permissions"),
    upsertSchema("holder_permissions"),
    upsertSchema("outputs"),
    upsertSchema("phones"),
    upsertSchema("call_settings"),
  ]),
  z.object({
    change_id: changeIdSchema,
    table: tableNameSchema,
    op: z.literal("delete"),
    id: uuidSchema,
    updated_at: fechaIsoSchema,
  }),
]);

/** Cuerpo de `POST /changes`: hasta `CHANGES_PAGE` cambios, en el orden de la bandeja. */
export const pushRequestSchema = z.object({
  changes: z.array(pushItemSchema).max(CHANGES_PAGE),
});

/** Un cambio hecho en el panel (`POST /changes`). `data` solo en `upsert`. */
export type PushItem =
  | {
      [T in TableName]: {
        change_id: string;
        table: T;
        op: "upsert";
        id: string;
        updated_at: string;
        data: TableData[T];
      };
    }[TableName]
  | { change_id: string; table: TableName; op: "delete"; id: string; updated_at: string };

/**
 * Resultado de un cambio del panel. `current` acompaña a `superseded` y `rejected`
 * cuando lo que quedó en la nube difiere de lo enviado: `{data}` con la versión vigente
 * para ese panel, o `null` si el registro no existe.
 */
export interface PushResult {
  change_id: string;
  status: "applied" | "superseded" | "rejected";
  revision?: number;
  reason?: string;
  current?: { data: TableData[TableName] } | null;
}

/** Respuesta de `POST /changes`. */
export interface PushResponse {
  revision: number;
  results: PushResult[];
}

/** Máximo de registros por tabla en `POST /import-snapshot` (una instalación ronda los 150 titulares). */
export const MAX_SNAPSHOT_ROWS = 10_000;

const filasDe = <T extends TableName>(table: T) =>
  z.array(z.object({ id: uuidSchema, data: dataSchemas[table] })).max(MAX_SNAPSHOT_ROWS);

/**
 * Cuerpo de `POST /import-snapshot`: la base local completa del panel, con todas las
 * tablas replicadas (una tabla vacía va como `[]`; una tabla de más es un error). La
 * coherencia interna (referencias y valores únicos) la revisa `snapshotProblem`.
 */
export const importSnapshotRequestSchema = z.object({
  tables: z.strictObject({
    holders: filasDe("holders"),
    cards: filasDe("cards"),
    controls: filasDe("controls"),
    control_buttons: filasDe("control_buttons"),
    permissions: filasDe("permissions"),
    holder_permissions: filasDe("holder_permissions"),
    outputs: filasDe("outputs"),
    // Un panel v7 no las envía.
    phones: filasDe("phones").default([]),
    call_settings: z.array(z.object({ id: uuidSchema, data: dataSchemas.call_settings })).max(1).default([]),
  }),
});

/**
 * Las tablas del snapshot de un panel (`POST /import-snapshot`). `phones` y
 * `call_settings` faltan en un snapshot guardado antes de v8 (la ruta las completa con `[]`).
 */
export type SnapshotTables = { [T in Exclude<TableName, "phones" | "call_settings">]: ContractRow<T>[] } & {
  phones?: ContractRow<"phones">[];
  call_settings?: ContractRow<"call_settings">[];
};

/**
 * Un log de acceso del panel (`POST /logs`), con los nombres del log local. Los rangos
 * de `source` y `reason` son amplios a propósito: un motivo nuevo del panel no debe
 * atascar el lote con un 400 eterno (`source` 5 es "Prueba", la prueba de una salida).
 * `output_id` es el `output_index` de la nube.
 */
export const logItemSchema = z.object({
  local_log_id: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  timestamp: fechaIsoSchema,
  allowed: z.boolean(),
  source: entero(0, 255),
  reason: entero(0, 255),
  holder_id: uuidSchema.nullish(),
  holder_name: texto.max(1000).nullish(),
  holder_kind: z.enum(["persona", "domicilio"]).nullish(),
  credential_label: texto.max(1000).nullish(),
  control_id: uuidSchema.nullish(),
  code: codigo32.nullish(),
  device_id: entero(0, 255).nullish(),
  output_id: entero(0, 3).nullish(),
});

export type LogItem = z.infer<typeof logItemSchema>;

/**
 * Cuerpo de `POST /logs`: de 0 a `LOG_BATCH` logs. La lista vacía es la respuesta del
 * panel a "Actualizar logs" cuando no tiene logs pendientes: solo marca la hora de subida.
 */
export const logsRequestSchema = z.object({
  logs: z.array(logItemSchema).max(LOG_BATCH),
});

/** Cuerpo de `POST /alerts`: el panel bloqueó un borrado masivo en `holders` o `cards`. */
export const alertRequestSchema = z.object({
  type: z.literal("mass_delete_blocked"),
  table: z.enum(["holders", "cards"]),
  would_delete: z.int().min(0),
  total: z.int().min(0),
});

/**
 * Cuerpo de `POST /command-result`: el resultado de una orden de la nube (`test_output` o
 * `remote_open` o `listen_rf`). `detail` es el texto del panel (o nulo); `reason` es el
 * motivo de la decisión del daemon y solo llega en `remote_open`; `rf_code` es el código
 * RF captado y solo llega en `listen_rf`.
 */
export const commandResultSchema = z.strictObject({
  command_id: uuidSchema,
  ok: z.boolean(),
  detail: texto.max(200).nullable().optional(),
  reason: entero(0, 255).nullable().optional(),
  rf_code: entero(0, 4294967295).nullable().optional(),
});

export type CommandResult = z.infer<typeof commandResultSchema>;
