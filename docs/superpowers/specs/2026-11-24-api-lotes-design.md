# API pública: endpoints de carga por lote

**Fecha:** 2026-11-24. **Origen:** solicitud de la app WEADMI (cliente de la API), aprobada por el dueño. El texto completo de la solicitud está abajo; es el requisito.

## Decisiones de implementación [decisión de Claude]
- **Rutas:** `POST /installations/{installationId}/holders/batch`, `/cards/batch` y `/controls/batch` (subruta `/batch`; los dos puntos de la URL no se usan). Se documenta en el OpenAPI.
- **Una revisión por lote:** el lote se procesa en una sola transacción de la base, con un punto de guardado (savepoint) por elemento, para que un elemento que falla se revierta solo y la revisión de la instalación suba una sola vez y salga un solo aviso a los paneles. Si el diseño actual (revisión por fila, aviso por cambio de revisión) no lo permite tal cual, el implementador ajusta la base para que el resultado observable sea el de la solicitud (§5.4 y criterio 1 y 10).
- **Tiempo:** el máximo de 200 se mantiene si el lote de 200 termina holgado dentro del límite de la función en Vercel; si no, se baja y se documenta.
- **§7 (búsqueda por código) se incluye.**
- **Límite por minuto:** un lote cuenta como una petición.

### Decisiones tomadas al implementar [decisión de Claude]
- **Mecanismo de una revisión por lote: "modo lote" en la base, no una transacción.** La lógica de cada elemento vive en TypeScript (`src/lib/{holders,cards,controls}.ts`) y hace varias peticiones a la Data API, cada una en su propia transacción; meter el lote en una transacción con savepoints obligaría a reescribir todas las reglas en SQL (duplicarlas). En su lugar (migración `api_batch`): `api_batch_begin` abre un lote por instalación con un token; las escrituras del lote llevan el encabezado `x-acc-batch: <token>` (solo con la llave secreta, rol `service_role`) y `private.bump_revision` les da la revisión pendiente (`installations.revision + 1`) sin subir `installations.revision`, así que no hay aviso y el pull (`since < revision ≤ R`) no las ve a medias; `api_batch_end` sube la revisión una sola vez si hubo alguna escritura confirmada (un elemento que falla revierte su transacción y su marca). Una escritura ajena durante el lote sube la revisión como siempre y publica lo que el lote llevaba (la revisión sube más de una vez solo en ese caso; nunca se pierde una fila). Un lote abandonado caduca a los 70 s (la función dura como máximo 60 s) y lo publica la siguiente apertura, la siguiente escritura o el trabajo `api-batches-expire` (cada minuto). Dos lotes simultáneos en la misma instalación: el segundo responde `429 batch_in_progress` con `Retry-After: 5`.
- **Pull con revisiones repetidas:** varias filas comparten revisión, así que `GET /changes` ya no corta una página dentro de un grupo de la misma revisión (corta antes o trae el grupo entero). El agente del panel ya acepta páginas de cualquier tamaño: no cambia el paquete.
- **Misma lógica y mismos errores:** las rutas individuales y los lotes usan las mismas funciones (`operacionesTitulares`, `operacionesTarjetas`, `operacionesControles`) y la misma traducción de errores (`apiErrorBody`).
- **Huella de idempotencia canónica:** para que "mismo contenido" coincida entre la llamada individual (texto JSON) y el elemento (`data`), la huella se calcula sobre el JSON canónico (llaves ordenadas). Se sigue aceptando la huella anterior (texto tal cual) de las llaves guardadas antes del cambio. `idempotency_key` admite de 1 a 200 caracteres (el límite del encabezado, no 255), porque comparten espacio.
- La respuesta de cada elemento se guarda en cuanto termina (no al final): si la función se corta, el reintento repite lo confirmado y no lo reejecuta. Un éxito guarda `{data, revision}` con la revisión pendiente del lote (la que tendrá al cerrarse, salvo escrituras ajenas concurrentes). `bump_revision` solo convierte a jsonb los GUC que empiezan con `{` (supuesto: PostgREST siempre manda un objeto JSON válido), sin `exception when others` ni `pg_input_is_valid` (Postgres 16+), para no abrir una subtransacción por escritura y funcionar en Postgres 15. La misma llave repetida dentro de un lote da 409 en el segundo elemento (como dos llamadas simultáneas).
- **Tiempo:** medido contra el Supabase local, 200 titulares ~1,2 s, tarjetas ~1,4 s y controles ~2,4 s (≈7, 8 y 13 peticiones a la base por elemento). Se mantiene el máximo de 200 y las rutas declaran `maxDuration = 60`; con 3 ms de latencia por petición entre Vercel y Supabase se estima ≤ 8 s.

---

## Solicitud original de WEADMI

(Ver el mensaje del dueño del 2026-11-24; se reproduce íntegra a continuación.)

### 1. Contexto y objetivo
Hoy WEADMI sincroniza con access-core una operación a la vez: un `POST`, `PATCH`, `PUT` o `DELETE` por titular, tarjeta o control, cada uno con su encabezado `Idempotency-Key`. Con la carga masiva, una importación puede generar cientos de operaciones: es lento, choca con el 429 y sube la `revision` cientos de veces (cientos de sincronizaciones de paneles).
**Objetivo:** procesar muchas operaciones del mismo recurso en una sola llamada, con un resultado por elemento, y subir la `revision` una sola vez por lote.

### 2. Endpoints nuevos
| Método | Ruta | Recurso |
|---|---|---|
| `POST` | `/installations/{installationId}/holders:batch` | Titulares |
| `POST` | `/installations/{installationId}/cards:batch` | Tarjetas |
| `POST` | `/installations/{installationId}/controls:batch` | Controles |

Si el framework no acepta `:`, se puede usar `/batch` como subruta; documentar en el OpenAPI cuál se eligió. `PUT /installations/{id}/profiles/{profileId}/holders` ya funciona como lote y no cambia. Autenticación: la misma API key Bearer, con los mismos permisos que la operación individual.

### 3. Petición
```json
{
  "items": [
    { "ref": "4821", "op": "create", "idempotency_key": "sync-4821-1", "data": { "kind": "domicilio", "name": "Calle Roble #10", "address": "…" } },
    { "ref": "4822", "op": "update", "id": "6f1c…", "idempotency_key": "sync-4822-1", "data": { "name": "Calle Roble #12" } },
    { "ref": "4823", "op": "delete", "id": "9a7b…", "idempotency_key": "sync-4823-1" }
  ]
}
```
| Campo | Tipo | Regla |
|---|---|---|
| `items` | arreglo | Entre 1 y **200** elementos. |
| `ref` | string (máx. 64) | Del cliente; se devuelve sin cambios; único en el lote. |
| `op` | `create` \| `update` \| `delete` | Operación. |
| `id` | uuid | Obligatorio en `update` y `delete`; prohibido en `create`. |
| `idempotency_key` | string (máx. 255) | Obligatorio; igual que el encabezado `Idempotency-Key` (§6). |
| `data` | objeto | En `create` y `update`; mismo cuerpo que el endpoint individual; no en `delete`. |

Cuerpos: titulares `create` = `{ kind, name, department?, address?, notes? }`, `update` = mismos campos opcionales (PATCH); tarjetas `create` = `{ card_code, holder_id, description? }`, `update` = como el PATCH actual; controles `create`/`update` = `{ holder_id, description?, buttons: [{ id?, button, rf_code?, outputs? }] }` (`update` reemplaza todo, como el PUT).

### 4. Respuesta
Lote procesado: `200 OK` aunque fallen elementos:
```json
{
  "revision": 58,
  "results": [
    { "ref": "4821", "ok": true, "id": "c3d2…", "data": { "…": "objeto como el endpoint individual" } },
    { "ref": "4822", "ok": false, "status": 409, "code": "card_code_taken", "message": "La tarjeta 123456 ya existe" },
    { "ref": "4823", "ok": false, "status": 404, "code": "not_found", "message": "Titular no encontrado" }
  ]
}
```
- Un resultado por `item`, en el mismo orden y con el mismo `ref`.
- `ok: true`: `id` (nuevo en `create`, el enviado en `update`/`delete`); `data` opcional como el endpoint individual.
- `ok: false`: `status`, `code` y `message` **exactamente** como el endpoint individual (400/422 cuerpo inválido, 404 no existe, 409 conflicto/duplicado).
- `revision`: la de la instalación al terminar; sube **una sola vez** si algo cambió; si nada cambió, igual.

Errores del lote completo (no se procesa nada): `400 {code:"invalid_batch"}` (JSON inválido, `items` vacío o >200, `ref` repetido, falta `idempotency_key`, `op` desconocida); 401/403, 404 (instalación), 429 (con `Retry-After`) y 5xx como hoy. Formato `{ "code", "message" }`.

### 5. Semántica
1. Éxito parcial: cada elemento por separado; un fallo no revierte a los demás.
2. Orden de llegada; un mismo `id` dos veces = dos llamadas individuales seguidas.
3. Sin referencias entre elementos del mismo lote (los `holder_id` ya existen).
4. Una sola revisión y una sola notificación a paneles por lote.
5. Error inesperado en un elemento: `ok:false, status:500, code:"internal_error"` y los demás siguen; el 5xx del lote solo si no se pudo procesar.
6. Un lote de 200 debe terminar dentro del tiempo máximo de la plataforma; si no cabe, bajar el máximo y documentarlo. No responder antes de terminar.

### 6. Idempotencia por elemento
- Cada `idempotency_key` se registra igual que el encabezado actual y **en el mismo espacio de llaves**: una operación hecha por el endpoint individual con la llave `X` no se repite en un lote con `X`, y al revés.
- Misma llave y mismo contenido: no se reaplica; se devuelve el resultado original con su `id`.
- Misma llave con otro contenido: el mismo error que da hoy el endpoint individual, como resultado del elemento.
- Las llaves se guardan al menos lo mismo que hoy.

### 7. Opcional: buscar por código
`GET /installations/{id}/cards?codes=123456,789012` y `GET /installations/{id}/controls?rf_codes=1001,1002`: máximo 200 códigos, `{ "data": [...] }` con el esquema del listado actual, lista vacía si no hay coincidencias.

### 8. Fuera de alcance
Lotes asíncronos; CSV/Excel; todo o nada; lotes que mezclen recursos.

### 9. Criterios de aceptación
1. 3 `create` válidos → 200, 3 `ok:true` con ids nuevos, `revision` +1 exacto.
2. 2 válidos + 1 tarjeta duplicada → 200; 2 ok y 1 con el mismo status/code que el POST individual; las 2 quedan guardadas.
3. Repetir el lote (mismas llaves) → sin duplicados, mismos ids, `revision` sin cambio.
4. Llave usada antes en el endpoint individual → el lote no reaplica.
5. `items` vacío, 201 elementos o `ref` repetido → `400 invalid_batch` sin cambios.
6. `update`/`delete` sin `id` o `create` con `id` → falla solo ese elemento con 400.
7. `delete` de id inexistente → falla solo ese elemento con 404.
8. Resultados en el mismo orden y con el mismo `ref`.
9. Mezcla de create/update/delete del mismo recurso = mismo estado que llamadas una por una.
10. Los paneles reciben una sola notificación por lote.
11. OpenAPI actualizado con endpoints, esquemas y límite.

### 10. Uso por WEADMI
Agrupa por recurso en bloques de hasta 200 (`ref` = id de tarea; `idempotency_key` = la llave de la tarea). Con cada resultado: si `ok`, guarda el `id`; si 429 o 5xx, reintenta ese elemento; otro error lo marca en la tarea. Los endpoints individuales siguen y deben convivir.
