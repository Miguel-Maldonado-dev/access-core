/**
 * Documento OpenAPI 3.1 de la API pública `/api/v1`, escrito a mano. Cada pareja (ruta, método)
 * de `src/app/api/v1/**` debe estar aquí: lo verifica `tests/api/openapi.test.ts`.
 */

type Obj = Record<string, unknown>;

const ref = (nombre: string) => ({ $ref: `#/components/schemas/${nombre}` });
const uuid = { type: "string", format: "uuid" };
const uuidNulo = { type: ["string", "null"], format: "uuid" };
const CODIGO_MAX = 4294967295;
const jsonDe = (schema: Obj) => ({ "application/json": { schema } });

/** `{data, revision}` de las escrituras. */
const escritura = (data: Obj) => ({
  type: "object",
  required: ["data", "revision"],
  properties: { data, revision: ref("Revision") },
});
const lectura = (data: Obj) => ({ type: "object", required: ["data"], properties: { data } });
const lista = (item: Obj) => lectura({ type: "array", items: item });

const respuestaError = (descripcion: string, extra: Obj = {}) => ({
  description: descripcion,
  content: jsonDe(ref("Error")),
  ...extra,
});

const E400 = respuestaError("`bad_request`: cuerpo, parámetro o dato no válido (el mensaje nombra el campo).");
const E401 = respuestaError("`invalid_api_key`: llave ausente, inválida o revocada.");
const E404 = respuestaError("`not_found`: el recurso no existe o es de otro tenant.");
const E409 = respuestaError(
  "`conflict`: dato repetido, o la petición original con la misma `Idempotency-Key` sigue en curso.",
);
const E422 = respuestaError("`idempotency_mismatch`: la `Idempotency-Key` ya se usó con otro cuerpo.");
const E429 = respuestaError("`rate_limited`: más de 120 peticiones por minuto con esta llave.", {
  headers: { "Retry-After": { description: "Segundos que hay que esperar.", schema: { type: "string" } } },
});
const E500 = respuestaError("`internal_error`: error interno del servidor.");

const pInstalacion = { $ref: "#/components/parameters/installationId" };
const idemKey = { $ref: "#/components/parameters/IdempotencyKey" };
const param = (name: string, descripcion: string) => ({
  name,
  in: "path",
  required: true,
  description: descripcion,
  schema: uuid,
});
const pTitular = param("holderId", "Id del titular.");
const pTarjeta = param("cardId", "Id de la tarjeta.");
const pControl = param("controlId", "Id del control.");
const pPerfil = param("profileId", "Id del perfil.");
const pSalida = param("outputId", "Id de la salida.");

interface Op {
  resumen: string;
  descripcion?: string;
  tag: string;
  params?: Obj[];
  body?: Obj;
  ok: Obj;
  status?: "200" | "201";
  /** Admite `Idempotency-Key` (escrituras salvo los PIN). */
  idem?: boolean;
  errores?: Obj;
  publica?: boolean;
}

function op(o: Op): Obj {
  const status = o.status ?? "200";
  const params = [...(o.params ?? []), ...(o.idem ? [idemKey] : [])];
  const respuestas: Obj = {
    [status]: {
      description: status === "201" ? "Creado." : "Correcto.",
      content: jsonDe(o.ok),
      ...(o.idem
        ? {
            headers: {
              "Idempotent-Replayed": {
                description: "`true` si es la respuesta guardada de una petición repetida con la misma `Idempotency-Key`.",
                schema: { type: "string", enum: ["true"] },
              },
            },
          }
        : {}),
    },
    400: E400,
    ...(o.publica ? {} : { 401: E401, 429: E429 }),
    ...(o.params?.some((p) => p === pInstalacion || p.in === "path") ? { 404: E404 } : {}),
    ...(o.idem ? { 409: E409, 422: E422 } : {}),
    ...(o.errores ?? {}),
    500: E500,
  };
  return {
    summary: o.resumen,
    ...(o.descripcion ? { description: o.descripcion } : {}),
    tags: [o.tag],
    ...(o.publica ? { security: [] } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(o.body ? { requestBody: { required: true, content: jsonDe(o.body) } } : {}),
    responses: respuestas,
  };
}

const SIN_IDEM_PIN =
  " No admite `Idempotency-Key`: si se envía, responde 400, para no guardar el PIN en la respuesta repetible.";

/** Cuerpo de `POST` de controles; el de `PUT` (`ControlReemplazo`) exige además `description`. */
const controlCuerpo = {
  type: "object",
  required: ["holder_id", "buttons"],
  additionalProperties: false,
  properties: {
    holder_id: uuid,
    description: { type: "string" },
    buttons: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["button"],
        additionalProperties: false,
        properties: {
          id: { ...uuidNulo, description: "Id de un botón existente, para editarlo; `null` o ausente = botón nuevo." },
          button: { type: "integer", minimum: 0, maximum: 3 },
          rf_code: {
            type: ["integer", "null"],
            minimum: 0,
            maximum: CODIGO_MAX,
            description: "Código RF en decimal. `null` en un botón existente lo borra; en uno nuevo se ignora.",
          },
          outputs: {
            type: "object",
            description:
              "`panel_id` → salida. Un entero de 0 a 3 elige la salida. `null` es \"Ninguna\" y borra el vínculo con ese panel. `\"sin_salida\"` solo conserva un vínculo que ya existe sin salida (si no existe, 400). Los paneles que no vienen no se tocan.",
            additionalProperties: {
              oneOf: [{ type: "integer", minimum: 0, maximum: 3 }, { type: "null" }, { const: "sin_salida" }],
            },
          },
        },
      },
    },
  },
};

const paths: Record<string, Obj> = {
  "/me": {
    get: op({
      resumen: "Identifica la llave",
      tag: "Cuenta",
      ok: { type: "object", required: ["tenant_id", "key"], properties: { tenant_id: uuid, key: ref("LlaveInfo") } },
    }),
  },
  "/installations": {
    get: op({ resumen: "Lista las instalaciones del tenant", tag: "Instalaciones", ok: lista(ref("Instalacion")) }),
  },
  "/installations/{installationId}": {
    get: op({
      resumen: "Obtiene una instalación",
      tag: "Instalaciones",
      params: [pInstalacion],
      ok: lectura(ref("Instalacion")),
    }),
  },
  "/installations/{installationId}/sync-status": {
    get: op({
      resumen: "Estado de sincronización",
      descripcion: "Revisión de la instalación y si cada panel vinculado ya la aplicó.",
      tag: "Instalaciones",
      params: [pInstalacion],
      ok: lectura({
        type: "object",
        required: ["revision", "panels"],
        properties: {
          revision: ref("Revision"),
          panels: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "panel_code", "online", "synced_revision", "applied"],
              properties: {
                id: uuid,
                panel_code: { type: "string" },
                online: { type: "boolean" },
                synced_revision: { type: "integer" },
                applied: { type: "boolean", description: "`synced_revision >= revision`." },
              },
            },
          },
        },
      }),
    }),
  },
  "/installations/{installationId}/panels": {
    get: op({ resumen: "Lista los paneles", tag: "Paneles", params: [pInstalacion], ok: lista(ref("Panel")) }),
  },
  "/installations/{installationId}/outputs": {
    get: op({ resumen: "Lista las salidas", tag: "Salidas", params: [pInstalacion], ok: lista(ref("Salida")) }),
  },
  "/installations/{installationId}/outputs/{outputId}/open": {
    post: op({
      resumen: "Abre una salida a distancia",
      descripcion:
        "Pide al panel de la salida abrirla a nombre del titular y espera su confirmación hasta 8 s (la orden vence a los 10 s). El panel decide con el permiso del titular (`allow_remote`, salidas, días y horario). No es un alta: responde 200 con el resultado en `status`: `opened` (abierta), `denied` (rechazada por salida, permiso o titular; motivos 2, 3 y 11), `failed` (otro error, como la salida ya en uso) o `timeout` (sin confirmación a tiempo). Con `Idempotency-Key` la respuesta se guarda al terminar la espera: una repetición devuelve el mismo resultado sin volver a abrir, y si llega mientras la primera sigue esperando responde 409. `timeout` no garantiza que la salida no se haya abierto (la orden vence a los 10 s y la API deja de esperar a los 8 s): revisa los logs antes de insistir; un reintento con otra `Idempotency-Key` es una orden nueva y puede abrir de nuevo.",
      tag: "Salidas",
      params: [pInstalacion, pSalida],
      body: ref("AperturaRemota"),
      ok: lectura(ref("ResultadoApertura")),
      idem: true,
      errores: {
        400: respuestaError("`bad_request`: cuerpo inválido, o `El titular no existe.` (borrado o de otra instalación)."),
        409: respuestaError(
          "`conflict`: `Panel sin conexión` (panel fuera de línea o no activo), `La salida ya tiene una orden en curso.`, o la petición original con la misma `Idempotency-Key` sigue en curso.",
        ),
        502: respuestaError(
          "`bad_gateway`: EMQX rechazó el mensaje, así que la orden no llegó al panel; se puede reintentar. Un fallo de red al publicar no da 502: la API sigue esperando y responde 200 con el resultado o `timeout`.",
        ),
      },
    }),
  },
  "/installations/{installationId}/logs": {
    get: op({
      resumen: "Lista los logs de acceso",
      descripcion:
        "Una página de 50 logs, del más reciente al más viejo. Un filtro inválido o desconocido responde 400 `bad_request`.",
      tag: "Logs",
      params: [
        pInstalacion,
        { name: "desde", in: "query", description: "Día inicial `AAAA-MM-DD`.", schema: { type: "string", format: "date" } },
        { name: "hasta", in: "query", description: "Día final `AAAA-MM-DD`.", schema: { type: "string", format: "date" } },
        { name: "panel", in: "query", description: "Id de panel.", schema: uuid },
        { name: "titular", in: "query", description: "Id de titular.", schema: uuid },
        { name: "resultado", in: "query", schema: { type: "string", enum: ["permitido", "denegado"] } },
        {
          name: "origen",
          in: "query",
          description: "Origen del evento: 0 tarjeta, 1 control RF, 2 botón de salida, 3 PIN, 4 remota, 5 prueba.",
          schema: { type: "string", enum: ["0", "1", "2", "3", "4", "5"] },
        },
        { name: "pagina", in: "query", description: "Número de página (desde 1).", schema: { type: "string", pattern: "^[1-9]\\d*$" } },
      ],
      ok: {
        type: "object",
        required: ["data", "page", "page_size", "total"],
        properties: {
          data: { type: "array", items: ref("Log") },
          page: { type: "integer" },
          page_size: { type: "integer" },
          total: { type: "integer" },
        },
      },
    }),
  },
  "/installations/{installationId}/holders": {
    get: op({
      resumen: "Lista los titulares",
      descripcion: "Expone `has_pin`, nunca el PIN.",
      tag: "Titulares",
      params: [pInstalacion],
      ok: lista(ref("Titular")),
    }),
    post: op({
      resumen: "Crea un titular",
      descripcion: "Se crea sin PIN; el PIN se pone con `PUT .../holders/{holderId}/pin`.",
      tag: "Titulares",
      params: [pInstalacion],
      body: ref("TitularCrear"),
      ok: escritura(ref("Titular")),
      status: "201",
      idem: true,
    }),
  },
  "/installations/{installationId}/holders/{holderId}": {
    get: op({
      resumen: "Obtiene un titular",
      tag: "Titulares",
      params: [pInstalacion, pTitular],
      ok: lectura(ref("Titular")),
    }),
    patch: op({
      resumen: "Edita un titular",
      descripcion: "Cambia solo los campos enviados y conserva el PIN. Un cuerpo vacío responde 400.",
      tag: "Titulares",
      params: [pInstalacion, pTitular],
      body: ref("TitularEditar"),
      ok: escritura(ref("Titular")),
      idem: true,
    }),
    delete: op({
      resumen: "Borra un titular",
      descripcion: "Borrado lógico.",
      tag: "Titulares",
      params: [pInstalacion, pTitular],
      ok: escritura(ref("IdObjeto")),
      idem: true,
    }),
  },
  "/installations/{installationId}/holders/{holderId}/pin": {
    put: op({
      resumen: "Fija o genera el PIN",
      descripcion:
        "Con `{pin}` fija ese PIN (4 a 6 dígitos) y responde `{has_pin: true}`. Con `{generate: true}` genera uno de 6 dígitos y lo devuelve **una sola vez**." +
        SIN_IDEM_PIN,
      tag: "Titulares",
      params: [pInstalacion, pTitular],
      body: {
        oneOf: [
          { type: "object", required: ["pin"], additionalProperties: false, properties: { pin: { type: "string", pattern: "^\\d{4,6}$", description: "De 4 a 6 dígitos." } } },
          {
            type: "object",
            required: ["generate"],
            additionalProperties: false,
            properties: { generate: { type: "boolean", enum: [true] } },
          },
        ],
      },
      ok: escritura({
        oneOf: [
          { type: "object", required: ["has_pin"], properties: { has_pin: { type: "boolean", enum: [true] } } },
          { type: "object", required: ["pin"], properties: { pin: { type: "string", pattern: "^\\d{6}$", description: "PIN generado; solo se muestra aquí." } } },
        ],
      }),
      errores: { 409: respuestaError("`conflict`: El PIN ya está asignado a otro titular.") },
    }),
    delete: op({
      resumen: "Quita el PIN",
      descripcion: "Responde `{has_pin: false}`." + SIN_IDEM_PIN,
      tag: "Titulares",
      params: [pInstalacion, pTitular],
      ok: escritura({ type: "object", required: ["has_pin"], properties: { has_pin: { type: "boolean", enum: [false] } } }),
    }),
  },
  "/installations/{installationId}/cards": {
    get: op({
      resumen: "Lista las tarjetas",
      descripcion: "Códigos en decimal.",
      tag: "Tarjetas",
      params: [pInstalacion],
      ok: lista(ref("Tarjeta")),
    }),
    post: op({
      resumen: "Crea una tarjeta",
      descripcion: "409 si el código ya está registrado.",
      tag: "Tarjetas",
      params: [pInstalacion],
      body: ref("TarjetaCrear"),
      ok: escritura(ref("Tarjeta")),
      status: "201",
      idem: true,
    }),
  },
  "/installations/{installationId}/cards/{cardId}": {
    patch: op({
      resumen: "Edita una tarjeta",
      descripcion: "Cambia titular o descripción; el código no se edita. Un cuerpo vacío responde 400.",
      tag: "Tarjetas",
      params: [pInstalacion, pTarjeta],
      body: ref("TarjetaEditar"),
      ok: escritura(ref("Tarjeta")),
      idem: true,
    }),
    delete: op({
      resumen: "Borra una tarjeta",
      descripcion: "Borrado lógico.",
      tag: "Tarjetas",
      params: [pInstalacion, pTarjeta],
      ok: escritura(ref("IdObjeto")),
      idem: true,
    }),
  },
  "/installations/{installationId}/controls": {
    get: op({
      resumen: "Lista los controles",
      descripcion: "Incluye los botones y la salida por panel.",
      tag: "Controles",
      params: [pInstalacion],
      ok: lista(ref("Control")),
    }),
    post: op({
      resumen: "Crea un control",
      descripcion: "Un botón sin salida en ningún panel no se crea.",
      tag: "Controles",
      params: [pInstalacion],
      body: ref("ControlCuerpo"),
      ok: escritura(ref("Control")),
      status: "201",
      idem: true,
    }),
  },
  "/installations/{installationId}/controls/{controlId}": {
    get: op({
      resumen: "Obtiene un control",
      tag: "Controles",
      params: [pInstalacion, pControl],
      ok: lectura(ref("Control")),
    }),
    put: op({
      resumen: "Reemplaza un control",
      descripcion:
        "Reemplaza titular, descripción y los botones enviados; los botones que no vienen no se tocan. La `description` es obligatoria (`\"\"` la deja vacía).",
      tag: "Controles",
      params: [pInstalacion, pControl],
      body: ref("ControlReemplazo"),
      ok: escritura(ref("Control")),
      idem: true,
    }),
    delete: op({
      resumen: "Borra un control",
      descripcion: "Borrado lógico.",
      tag: "Controles",
      params: [pInstalacion, pControl],
      ok: escritura(ref("IdObjeto")),
      idem: true,
    }),
  },
  "/installations/{installationId}/profiles": {
    get: op({
      resumen: "Lista los perfiles",
      descripcion: "Con sus reglas por panel y los ids de sus titulares.",
      tag: "Perfiles",
      params: [pInstalacion],
      ok: lista(ref("Perfil")),
    }),
    post: op({
      resumen: "Crea un perfil",
      descripcion: "Usa el menor número de permiso libre.",
      tag: "Perfiles",
      params: [pInstalacion],
      body: { type: "object", required: ["name"], additionalProperties: false, properties: { name: ref("NombrePerfil") } },
      ok: escritura(ref("Perfil")),
      status: "201",
      idem: true,
      errores: { 409: respuestaError("`conflict`: se llegó al máximo de 32 perfiles, o la petición original con la misma `Idempotency-Key` sigue en curso.") },
    }),
  },
  "/installations/{installationId}/profiles/{profileId}": {
    patch: op({
      resumen: "Renombra un perfil",
      descripcion: "Un cuerpo sin `name` responde 400.",
      tag: "Perfiles",
      params: [pInstalacion, pPerfil],
      body: { type: "object", additionalProperties: false, properties: { name: ref("NombrePerfil") } },
      ok: escritura(ref("Perfil")),
      idem: true,
    }),
    delete: op({
      resumen: "Borra un perfil",
      descripcion: "Borrado lógico; quita sus reglas y asignaciones.",
      tag: "Perfiles",
      params: [pInstalacion, pPerfil],
      ok: escritura(ref("IdObjeto")),
      idem: true,
    }),
  },
  "/installations/{installationId}/profiles/{profileId}/holders": {
    put: op({
      resumen: "Asigna los titulares de un perfil",
      descripcion: "Deja el perfil asignado exactamente a esos titulares. Un titular inexistente o ajeno responde 400.",
      tag: "Perfiles",
      params: [pInstalacion, pPerfil],
      body: {
        type: "object",
        required: ["holder_ids"],
        additionalProperties: false,
        properties: { holder_ids: { type: "array", items: uuid } },
      },
      ok: escritura(ref("Perfil")),
      idem: true,
      errores: { 409: respuestaError("`conflict`: choque de concurrencia con otra modificación al mismo tiempo, o la petición original con la misma `Idempotency-Key` sigue en curso.") },
    }),
  },
  "/installations/{installationId}/profiles/{profileId}/rules": {
    put: op({
      resumen: "Guarda las reglas de un perfil",
      descripcion: "Una entrada por panel; `rule: null` quita el acceso en ese panel. Los paneles que no vienen no se tocan.",
      tag: "Perfiles",
      params: [pInstalacion, pPerfil],
      body: {
        type: "array",
        items: {
          type: "object",
          required: ["panel_id", "rule"],
          additionalProperties: false,
          properties: { panel_id: uuid, rule: { oneOf: [ref("ReglaEntrada"), { type: "null" }] } },
        },
      },
      ok: escritura(ref("Perfil")),
      idem: true,
      errores: { 409: respuestaError("`conflict`: choque de concurrencia con otra modificación al mismo tiempo, o la petición original con la misma `Idempotency-Key` sigue en curso.") },
    }),
  },
};
const camposRegla = {
  output_mask: { type: "integer", minimum: 0, maximum: 15, description: "Máscara de salidas S1 a S4 (bit 0 = S1)." },
  card_reader_mask: { type: "integer", minimum: 0, maximum: 15, description: "Máscara de lectores L1 a L4 con tarjeta." },
  pin_reader_mask: { type: "integer", minimum: 0, maximum: 15, description: "Máscara de lectores L1 a L4 con PIN." },
  allow_rf: { type: "boolean" },
  allow_remote: { type: "boolean", description: "Permite la apertura remota de las salidas de la regla." },
  weekday_mask: { type: "integer", minimum: 0, maximum: 127, description: "Días de la semana; bit 0 = lunes." },
  start_minute: { type: "integer", minimum: 0, maximum: 1439, description: "Minuto del día en que empieza el horario." },
  end_minute: { type: "integer", minimum: 0, maximum: 1439, description: "Minuto del día en que termina el horario." },
};
const requeridosRegla = Object.keys(camposRegla);

/** Regla de respuesta (sin `additionalProperties: false`: `ReglaPanel` la extiende con `allOf`). */
const regla = { type: "object", required: requeridosRegla, properties: camposRegla };
/** Regla de entrada de `PUT .../rules`: estricta. */
const reglaEntrada = { ...regla, additionalProperties: false };

export const openapi: object = {
  openapi: "3.1.0",
  info: {
    title: "API pública de Access Core",
    version: "1.0.0",
    description: [
      "API REST para administrar una instalación de control de acceso desde sistemas externos.",
      "",
      "**Autenticación:** `Authorization: Bearer acc_…`. La llave actúa como admin del tenant en todas sus instalaciones; un recurso de otro tenant responde 404.",
      "",
      "**Errores:** `{code, message}` con mensaje en español. Códigos: `invalid_api_key` (401), `bad_request` (400), `not_found` (404), `conflict` (409), `idempotency_mismatch` (422), `rate_limited` (429, con `Retry-After`), `internal_error` (500) y `bad_gateway` (502, solo en la apertura remota).",
      "",
      "**Escrituras:** responden `{data, revision}`; los `POST` de alta responden 201 (la apertura remota, `POST .../outputs/{outputId}/open`, responde 200 `{data}` sin `revision`). `revision` se lee después de escribir, así que con escrituras concurrentes puede ser mayor que la de la propia escritura, aunque siempre es monótona. Con `GET .../sync-status` se sabe si los paneles ya la aplicaron.",
      "",
      "**Idempotencia:** `Idempotency-Key` (1 a 200 caracteres, vigente 24 h) es opcional en `POST`, `PATCH`, `PUT` y `DELETE`. La misma llave con el mismo cuerpo devuelve la respuesta guardada con `Idempotent-Replayed: true`; con otro cuerpo, 422; si la original sigue en curso, 409. No se admite en `PUT` ni `DELETE .../holders/{holderId}/pin` (400), para no guardar el PIN.",
      "",
      "**Límite:** 120 peticiones por minuto por llave; al pasarlo, 429 con `Retry-After`.",
    ].join("\n"),
  },
  servers: [{ url: "/api/v1", description: "Esta nube" }],
  security: [{ bearerAuth: [] }],
  tags: [
    "Cuenta",
    "Instalaciones",
    "Paneles",
    "Salidas",
    "Logs",
    "Titulares",
    "Tarjetas",
    "Controles",
    "Perfiles",
  ].map((name) => ({ name })),
  // `/openapi.json` (público) no se lista: es este mismo documento.
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "Llave de API (`acc_` + 43 caracteres)." },
    },
    parameters: {
      installationId: param("installationId", "Id de la instalación."),
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "Opcional, de 1 a 200 caracteres, vigente 24 h.",
        schema: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            description:
              "Código estable. Ejemplos: `invalid_api_key`, `bad_request`, `not_found`, `conflict`, `idempotency_mismatch`, `rate_limited`, `internal_error`, `bad_gateway`. Puede haber otros según el estado HTTP.",
          },
          message: { type: "string", description: "Texto en español." },
        },
      },
      Revision: {
        type: "integer",
        description:
          "Revisión de la instalación leída después de escribir; con escrituras concurrentes puede ser mayor que la de esta escritura, pero es monótona.",
      },
      AperturaRemota: {
        type: "object",
        required: ["holder_id", "requested_by"],
        additionalProperties: false,
        properties: {
          holder_id: { ...uuid, description: "Titular a cuyo nombre se abre; debe ser de la instalación." },
          requested_by: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            description: "Quién pide la apertura (p. ej. \"Caseta norte\"); queda en el log del panel. Sin caracteres de control (400).",
          },
        },
      },
      ResultadoApertura: {
        type: "object",
        required: ["command_id", "status", "reason", "detail"],
        properties: {
          command_id: uuid,
          status: { type: "string", enum: ["opened", "denied", "failed", "timeout"] },
          reason: {
            type: ["integer", "null"],
            minimum: 0,
            maximum: 255,
            description:
              "Motivo del panel: 0 abierta (o salida en uso, con `failed`), 2 salida inexistente o deshabilitada, 3 sin permiso, 4 fallo del relevador, 11 titular desconocido. Nulo en `timeout` o si el panel no lo envía.",
          },
          detail: { type: ["string", "null"], description: "Texto del panel en español; nulo en `timeout`." },
        },
      },
      NombrePerfil: { type: "string", minLength: 1, maxLength: 60, description: "De 1 a 60 caracteres." },
      IdObjeto: { type: "object", required: ["id"], properties: { id: uuid } },
      LlaveInfo: {
        type: "object",
        required: ["id", "name", "prefix"],
        properties: { id: uuid, name: { type: "string" }, prefix: { type: "string" } },
      },
      Instalacion: {
        type: "object",
        required: ["id", "name", "revision"],
        properties: { id: uuid, name: { type: "string" }, revision: ref("Revision") },
      },
      Panel: {
        type: "object",
        required: ["id", "panel_code", "status", "online", "last_sync_at", "synced_revision", "software_version"],
        properties: {
          id: uuid,
          panel_code: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "claimed", "staging", "awaiting_review", "active", "revoked"],
            description: "Estado del panel.",
          },
          online: { type: "boolean" },
          last_sync_at: { type: ["string", "null"], format: "date-time" },
          synced_revision: { type: "integer" },
          software_version: { type: ["string", "null"] },
        },
      },
      Salida: {
        type: "object",
        required: ["id", "panel_id", "output_index", "alias", "duration_ms", "reader_mask", "enabled"],
        properties: {
          id: uuid,
          panel_id: uuid,
          output_index: { type: "integer", minimum: 0, maximum: 3, description: "0 a 3 (S1 a S4)." },
          alias: { type: "string" },
          duration_ms: { type: "integer", minimum: 0, maximum: 65535 },
          reader_mask: { type: "integer", minimum: 0, maximum: 15, description: "Máscara de lectores L1 a L4." },
          enabled: { type: "boolean" },
        },
      },
      Log: {
        type: "object",
        required: [
          "id", "ts", "panel_id", "panel_code", "allowed", "source", "reason", "holder_id", "holder_name",
          "holder_kind", "credential_label", "control_id", "code", "device_id", "output_index", "output_alias",
        ],
        properties: {
          id: { type: "integer" },
          ts: { type: "string", format: "date-time" },
          panel_id: uuid,
          panel_code: { type: "string" },
          allowed: { type: "boolean" },
          source: {
            type: "integer",
            enum: [0, 1, 2, 3, 4, 5],
            description: "Origen: 0 tarjeta, 1 control RF, 2 botón de salida, 3 PIN, 4 remota, 5 prueba.",
          },
          reason: {
            type: "integer",
            minimum: 0,
            maximum: 11,
            description:
              "Motivo: 0 permitido, 1 tarjeta desconocida, 2 sin salida, 3 sin permiso, 4 error UART, 5 control desconocido, 6 botón sin salida, 7 botón de salida, 8 PIN desconocido, 9 PIN no permitido, 10 PIN bloqueado, 11 titular desconocido.",
          },
          holder_id: uuidNulo,
          holder_name: { type: ["string", "null"] },
          holder_kind: { type: ["string", "null"], enum: ["persona", "domicilio", null] },
          credential_label: { type: ["string", "null"] },
          control_id: uuidNulo,
          code: { type: ["integer", "null"], description: "En decimal; nulo en eventos de PIN." },
          device_id: { type: ["integer", "null"] },
          output_index: { type: ["integer", "null"] },
          output_alias: { type: ["string", "null"] },
        },
      },
      Titular: {
        type: "object",
        required: ["id", "kind", "name", "department", "address", "notes", "has_pin", "card_count", "control_count"],
        properties: {
          id: uuid,
          kind: { type: "string", enum: ["persona", "domicilio"] },
          name: { type: "string" },
          department: { type: "string" },
          address: { type: "string" },
          notes: { type: "string" },
          has_pin: { type: "boolean" },
          card_count: { type: "integer" },
          control_count: { type: "integer" },
        },
      },
      TitularCrear: {
        type: "object",
        required: ["kind", "name"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["persona", "domicilio"] },
          name: { type: "string" },
          department: { type: "string" },
          address: { type: "string" },
          notes: { type: "string" },
        },
      },
      TitularEditar: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["persona", "domicilio"] },
          name: { type: "string" },
          department: { type: "string" },
          address: { type: "string" },
          notes: { type: "string" },
        },
      },
      Tarjeta: {
        type: "object",
        required: ["id", "card_code", "holder_id", "holder_name", "description"],
        properties: {
          id: uuid,
          card_code: { type: "integer", minimum: 0, maximum: CODIGO_MAX, description: "En decimal." },
          holder_id: uuid,
          holder_name: { type: "string" },
          description: { type: "string" },
        },
      },
      TarjetaCrear: {
        type: "object",
        required: ["card_code", "holder_id"],
        additionalProperties: false,
        properties: {
          card_code: { type: "integer", minimum: 0, maximum: CODIGO_MAX },
          holder_id: uuid,
          description: { type: "string" },
        },
      },
      TarjetaEditar: {
        type: "object",
        additionalProperties: false,
        properties: { holder_id: uuid, description: { type: "string" } },
      },
      Boton: {
        type: "object",
        required: ["id", "button", "rf_code", "outputs"],
        properties: {
          id: uuid,
          button: { type: "integer", minimum: 0, maximum: 3, description: "Número de botón del control (0 a 3)." },
          rf_code: { type: "integer", minimum: 0, maximum: CODIGO_MAX, description: "En decimal." },
          outputs: {
            type: "object",
            description: "`panel_id` → índice de salida (`null` si el panel lo tiene sin salida).",
            additionalProperties: { type: ["integer", "null"], minimum: 0, maximum: 3 },
          },
        },
      },
      Control: {
        type: "object",
        required: ["id", "holder_id", "holder_name", "description", "buttons"],
        properties: {
          id: uuid,
          holder_id: uuid,
          holder_name: { type: "string" },
          description: { type: "string" },
          buttons: { type: "array", items: ref("Boton") },
        },
      },
      ControlCuerpo: controlCuerpo,
      ControlReemplazo: { ...controlCuerpo, required: ["holder_id", "description", "buttons"] },
      Regla: regla,
      // `allow_remote` es opcional al escribir (se conserva el actual) para no romper a los clientes de 2A.
      ReglaEntrada: {
        ...reglaEntrada,
        required: requeridosRegla.filter((c) => c !== "allow_remote"),
        properties: {
          ...camposRegla,
          allow_remote: {
            type: "boolean",
            description: "Permite la apertura remota. Si se omite, se conserva el valor actual (false en una regla nueva).",
          },
        },
      },
      ReglaPanel: {
        allOf: [
          ref("Regla"),
          {
            type: "object",
            required: ["id", "profile_id", "panel_id"],
            properties: { id: uuid, profile_id: uuid, panel_id: uuid },
          },
        ],
      },
      Perfil: {
        type: "object",
        required: ["id", "name", "local_permission_id", "holder_ids", "rules"],
        properties: {
          id: uuid,
          name: ref("NombrePerfil"),
          local_permission_id: { type: "integer" },
          holder_ids: { type: "array", items: uuid },
          rules: { type: "array", items: ref("ReglaPanel") },
        },
      },
    },
  },
};
