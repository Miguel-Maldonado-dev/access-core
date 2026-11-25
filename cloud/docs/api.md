# API pública de Access Core (`/api/v1`)

API REST para administrar una instalación desde sistemas externos: titulares, tarjetas, teléfonos (abrir llamando), PIN, controles, perfiles, apertura remota de salidas, y consulta de paneles, salidas, logs y estado de sincronización.

- **Base:** `https://<APP_URL>/api/v1` (en local, `http://localhost:3001/api/v1`).
- **OpenAPI 3.1:** `GET /api/v1/openapi.json` (público, sin llave). Es el contrato completo de rutas, cuerpos y respuestas.
- **Documentación interactiva:** `https://<APP_URL>/docs/api` (pública, sin sesión). Muestra esta guía y el OpenAPI con un visor (Scalar) donde se puede probar cada ruta. Se enlaza desde la pestaña **API** del tenant. El visor no usa recursos externos (sin CDN, fuentes remotas, proxy ni telemetría); **Probar** llama a este mismo origen con la llave que pegues y **no la guarda** (`persistAuth: false`: vive en memoria hasta cerrar o recargar la pestaña). Esta guía (`docs/api.md`) es la fuente: la página la lee al compilar, así que un cambio aquí se ve tras el siguiente despliegue.

En los ejemplos:

```bash
export API=https://<APP_URL>/api/v1
export KEY=acc_...            # la llave completa, tal como se mostró al crearla
export INST=<id-de-la-instalacion>
```

## Crear una llave

1. Entra a la nube como **admin** del tenant y abre la pestaña **API**.
2. Crea la llave con un nombre.
3. Copia la llave completa (`acc_` + 43 caracteres). **Se muestra una sola vez**; después solo se ve su prefijo. Si la pierdes, rota o revoca la llave y crea otra.

Reglas:

- Solo el admin del tenant ve la pestaña y administra llaves.
- Máximo **10 llaves vivas** por tenant.
- Cada llave tiene su **límite de peticiones por minuto** (de 1 a 5000, 120 por omisión): se fija al crearla y el admin lo edita en la pestaña **API**. Rotar una llave conserva su límite.
- Una llave revocada o rotada deja de funcionar de inmediato (401).
- **Alcance:** la llave actúa como admin del tenant en **todas** sus instalaciones. Una instalación o un recurso de otro tenant responde **404**, nunca 403.
- Las escrituras por la API quedan firmadas `api:<id>` en la auditoría.
- Cuando un admin deja el tenant, **revoca las llaves que creó** o que conoce: la llave no depende de su cuenta y sigue funcionando hasta que se revoca o se rota.

## Autenticación

```bash
curl -s -H "Authorization: Bearer $KEY" $API/me
```

```json
{ "tenant_id": "…", "key": { "id": "…", "name": "Integración", "prefix": "acc_xxxxxxxx" } }
```

`/me` es la única respuesta sin `data`. Sin llave, o con una inválida o revocada: `401` con `invalid_api_key`.

## Errores

Todos los errores tienen la forma `{"code": "...", "message": "<texto en español>"}`:

| Estado | `code` | Cuándo |
|---|---|---|
| 400 | `bad_request` | Cuerpo que no es JSON, campo de más o inválido (el mensaje nombra el campo), parámetro inválido |
| 401 | `invalid_api_key` | Llave ausente, inválida o revocada |
| 404 | `not_found` | El recurso no existe o es de otro tenant |
| 409 | `conflict` | Dato repetido (tarjeta, PIN), choque de concurrencia, o la petición original con la misma `Idempotency-Key` sigue en curso |
| 422 | `idempotency_mismatch` | `Idempotency-Key` ya usada con otro cuerpo |
| 429 | `rate_limited` | Más peticiones por minuto que el límite de la llave (120 por omisión; trae `Retry-After`) |
| 502 | `bad_gateway` | La apertura remota no pudo enviar la orden: EMQX rechazó el mensaje (se puede reintentar) |
| 500 | `internal_error` | Error interno |

## Límites

- **Límite por llave, configurable en la pestaña API** (de 1 a 5000 peticiones por minuto; **120 por omisión**). Al pasarlo, `429` con `Retry-After` (segundos). El cambio aplica en la siguiente petición.

## Idempotencia

`Idempotency-Key` es opcional en `POST`, `PATCH`, `PUT` y `DELETE`: de 1 a 200 caracteres, vigente 24 h.

- Misma llave y mismo cuerpo: devuelve la respuesta guardada con el encabezado `Idempotent-Replayed: true`. También se repiten los errores 4xx; los 5xx no se guardan, así que se pueden reintentar.
- Misma llave con otro cuerpo (u otra ruta): `422 idempotency_mismatch`.
- Si la petición original sigue en curso: `409 conflict`.
- **Es por llave:** la `Idempotency-Key` se guarda con la llave que la usó. Después de rotar la llave, un reintento con la llave nueva y la misma `Idempotency-Key` se ejecuta de nuevo.
- **Mismo contenido:** el cuerpo se compara como JSON canónico (sin importar espacios ni el orden de las llaves).
- **Lotes:** la `idempotency_key` de cada elemento de un lote comparte este mismo espacio de llaves (ver [Lotes](#lotes)).
- **No se admite en las rutas de PIN** (`PUT` y `DELETE .../holders/{holderId}/pin`): responden `400` si se envía, para no guardar el PIN en la respuesta repetible.

```bash
curl -s -X POST $API/installations/$INST/holders \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: alta-lote-0001" \
  -H "Content-Type: application/json" \
  -d '{"kind":"persona","name":"Ana Pérez","department":"12B"}'
```

## Escrituras y sincronización

Las escrituras responden `{"data": …, "revision": <n>}`; los `POST` de alta responden `201`. La apertura remota (`POST .../outputs/{outputId}/open`) no es una escritura de datos: responde `200` `{data}` sin `revision`. Cada escritura sube la revisión de la instalación y dispara la sincronización hacia los paneles. `revision` se lee después de escribir: con escrituras concurrentes puede ser mayor que la de la propia escritura, pero nunca retrocede.

Para saber si los paneles ya aplicaron un cambio, compara con `sync-status`:

```bash
curl -s -H "Authorization: Bearer $KEY" $API/installations/$INST/sync-status
```

```json
{ "data": { "revision": 42, "panels": [
  { "id": "…", "panel_code": "PNL-7K2M-9QXA", "online": true, "synced_revision": 42, "applied": true }
] } }
```

`applied` es `synced_revision >= revision`.

## Lotes

`POST /installations/{id}/holders/batch`, `.../cards/batch`, `.../phones/batch` y `.../controls/batch` procesan **hasta 200** operaciones del mismo recurso en una llamada (se usa la subruta `/batch`; la forma `holders:batch` no existe).

```bash
curl -s -X POST $API/installations/$INST/holders/batch \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "items": [
    {"ref":"4821","op":"create","idempotency_key":"sync-4821-1","data":{"kind":"domicilio","name":"Calle Roble #10"}},
    {"ref":"4822","op":"update","id":"<holder-id>","idempotency_key":"sync-4822-1","data":{"name":"Calle Roble #12"}},
    {"ref":"4823","op":"delete","id":"<holder-id>","idempotency_key":"sync-4823-1"}
  ]}'
# → 200 {"revision":58,"results":[
#   {"ref":"4821","ok":true,"id":"c3d2…","data":{…}},
#   {"ref":"4822","ok":true,"id":"<holder-id>","data":{…}},
#   {"ref":"4823","ok":false,"status":404,"code":"not_found","message":"El titular no existe."}]}
```

- **Elemento:** `ref` (1 a 64 caracteres, único en el lote, se devuelve igual), `op` (`create`, `update` o `delete`), `id` (obligatorio en `update` y `delete`, prohibido en `create`), `idempotency_key` (obligatoria, 1 a 200 caracteres) y `data` (en `create` y `update`, el mismo cuerpo que el endpoint individual; no en `delete`). `update` es el `PATCH` en titulares, tarjetas y teléfonos y el `PUT` (reemplazo) en controles.
- **Resultados:** `200` aunque fallen elementos, uno por elemento, en el mismo orden. `ok: true` trae `id` (nuevo en `create`) y `data` como el endpoint individual (`{id}` en `delete`). `ok: false` trae `status`, `code` y `message` **iguales** a los del endpoint individual (cada elemento usa la misma lógica). Un `id` faltante o sobrante, o `data` faltante o sobrante, falla solo ese elemento con `400 bad_request`. Un error inesperado da `500 internal_error` en ese elemento y los demás siguen.
- **Éxito parcial y orden:** cada elemento se aplica por separado y en orden; un fallo no revierte a los demás. El mismo `id` dos veces equivale a dos llamadas seguidas. Los elementos no pueden referirse a otros del mismo lote.
- **Revisión:** `revision` es la de la instalación al terminar y es una **cota inferior** de la revisión publicada (una escritura concurrente o un cierre fallido pueden dejar la publicada por encima); sube **una sola vez** si algo cambió y los paneles reciben un solo aviso; si nada cambió, no sube. (Si otra escritura ajena al lote llega mientras se procesa, la revisión puede subir más de una vez; nunca se pierde un cambio.) Si falla el cierre del lote, la respuesta trae la revisión actual, que todavía **no incluye** los cambios del lote: se publican solos al caducar el lote (como máximo ~70 s más un minuto del trabajo que lo cierra) y entonces los paneles reciben el aviso.
- **Idempotencia:** cada `idempotency_key` se guarda como el encabezado `Idempotency-Key` y en su mismo espacio de llaves: equivale a la llamada individual con el mismo método, ruta y cuerpo. Una operación hecha por el endpoint individual con la llave `X` no se repite en un lote con `X`, y al revés; se devuelve el resultado original con su `id`. La respuesta de cada elemento se guarda en cuanto termina, así que si la llamada se corta a mitad del lote, reintentarlo con las mismas llaves repite lo ya hecho (mismos ids) y solo ejecuta lo que faltaba; el elemento que estaba en curso responde `409` durante 60 s y después se retoma. La `revision` guardada con cada éxito es la que tendrá el lote al cerrarse (la pendiente). Con otro contenido, ese elemento falla con `422 idempotency_mismatch`. La misma llave dos veces en un lote: el segundo falla con `409` "La petición original sigue en curso.".
- **Errores del lote completo** (no se procesa nada): `400 invalid_batch` (JSON inválido, `items` vacío o con más de 200, `ref` repetido, falta `idempotency_key`, `op` desconocida o campos de más), `401`, `404` (instalación), `429 rate_limited` y `429 batch_in_progress` (otro lote en curso en la misma instalación; `Retry-After: 5`), `5xx`. Los dos 429 se distinguen por `code`: `rate_limited` es el límite por minuto de la llave y `batch_in_progress` solo pide reintentar el lote en unos segundos.
- **Límite por minuto:** un lote cuenta como **una** petición.
- **Tiempo:** medido contra el Supabase local, un lote de 200 tarda ~1,2 s (titulares), ~1,4 s (tarjetas) y ~2,4 s (controles), con ~7, ~8 y ~13 peticiones a la base por elemento. En producción el tiempo es aproximadamente peticiones × latencia entre Vercel y Supabase (con 3 ms, ~4 s, ~5 s y ~8 s). Las rutas declaran `maxDuration = 60` s. Si la latencia real pasara de ~20 ms por petición, habría que bajar el máximo.

### Buscar por código

`GET .../cards?codes=123456,789012` y `GET .../controls?rf_codes=1001,1002` (de 1 a 200 códigos decimales separados por comas), y `GET .../phones?numbers=5512345678,5587654321` (de 1 a 200 números de 10 dígitos) responden `{data: [...]}` con el esquema del listado; lista vacía si no hay coincidencias; un valor inválido, `400`.

## Ejemplos

### Titular

```bash
# Crear (sin PIN)
curl -s -X POST $API/installations/$INST/holders \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"kind":"persona","name":"Ana Pérez","department":"12B","address":"","notes":""}'
# → 201 {"data":{"id":"<holder-id>","kind":"persona","name":"Ana Pérez","has_pin":false,…},"revision":43}

export HOLDER=<holder-id>

# Listar, leer, editar (solo los campos enviados) y borrar
curl -s -H "Authorization: Bearer $KEY" $API/installations/$INST/holders
curl -s -H "Authorization: Bearer $KEY" $API/installations/$INST/holders/$HOLDER
curl -s -X PATCH $API/installations/$INST/holders/$HOLDER \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"notes":"Propietaria"}'
curl -s -X DELETE -H "Authorization: Bearer $KEY" $API/installations/$INST/holders/$HOLDER
```

Las lecturas exponen `has_pin`, nunca el PIN. `kind` es `persona` o `domicilio`.

### Tarjeta

El código se envía en decimal (0 a 4294967295). Si ya está registrado, `409`.

```bash
curl -s -X POST $API/installations/$INST/cards \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"card_code\":1234567,\"holder_id\":\"$HOLDER\"}"
```

### Teléfono

Permite que un titular abra llamando desde un número registrado (módulo SIM808 del panel). El número se envía con **10 dígitos** (se quitan espacios y guiones: `55 1234-5678` se guarda como `5512345678`). Si otro teléfono vivo de la instalación ya lo tiene, `409 conflict` con el mensaje "El número ya está registrado"; uno que no tenga 10 dígitos da `400`.

```bash
curl -s -X POST $API/installations/$INST/phones \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"number\":\"5512345678\",\"holder_id\":\"$HOLDER\",\"description\":\"Celular\"}"
```

- `PATCH .../phones/{id}` cambia `number`, `holder_id` o `description` (cuerpo vacío: `400 "No hay cambios."`); `DELETE` es un borrado lógico que libera el número; `GET .../phones?numbers=5512345678,5587654321` busca por número.
- **Reglas:** la regla de un perfil por panel lleva `allow_call` (abrir llamando). Es opcional al escribir: si se omite, se conserva el valor actual (`false` en una regla nueva); las respuestas siempre lo traen. Un teléfono abre solo las salidas que el perfil del titular permite con `allow_call`, dentro de su horario, y que el módulo de llamadas del panel tenga activas.
- **Los paneles solo reciben los teléfonos** si su módulo de llamadas está activado (se configura en la interfaz web, no en la API) y son v8; con el módulo apagado el panel recibe el borrado de todos sus teléfonos.
- **Advertencia de seguridad:** el identificador de llamada (CLIP) lo informa la red y **puede falsificarse**. Quien conozca un número registrado y pueda suplantarlo podría abrir las salidas que el permiso del titular permita. Concede `allow_call` solo a salidas de bajo riesgo y no lo uses como único control en accesos críticos.
- En los logs, el origen `6` es "Llamada", los motivos `12` y `13` son "Teléfono desconocido" y "Límite de llamadas" (máximo 3 aperturas por minuto por número); `credential_label` trae el número completo (`Oculto` si no llegó) y `device_id` la tecla del menú (1 a 4) cuando la hubo.

### PIN generado

```bash
curl -s -X PUT $API/installations/$INST/holders/$HOLDER/pin \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"generate":true}'
# → 200 {"data":{"pin":"483920"},"revision":44}
```

El PIN generado (6 dígitos) **solo aparece en esta respuesta**; guárdalo. Para fijar uno propio (4 a 6 dígitos) envía `{"pin":"4821"}`:

```bash
curl -s -X PUT $API/installations/$INST/holders/$HOLDER/pin \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"pin":"4821"}'
# → 200 {"data":{"has_pin":true},"revision":45}
```

Si otro titular de la instalación ya usa ese PIN, responde `409 conflict`. Es lo esperado (el PIN es único por instalación), y probar PIN de esta forma queda acotado por el límite de peticiones por minuto de la llave (120 por omisión). Para quitarlo:

```bash
curl -s -X DELETE -H "Authorization: Bearer $KEY" $API/installations/$INST/holders/$HOLDER/pin
# → {"data":{"has_pin":false},"revision":46}
```

### Control por panel

Cada botón (0 a 3) lleva su `rf_code` en decimal y, en `outputs`, la salida que activa en cada panel: `{<panel_id>: 0..3 | null | "sin_salida"}`.

- Un entero de 0 a 3 elige la salida (S1 a S4).
- `null` es "Ninguna": borra el vínculo con ese panel.
- `"sin_salida"` solo conserva un vínculo que ya existe sin salida (si no existe, `400`).
- Los paneles que no vienen no se tocan, y un botón sin salida en ningún panel no se crea.

Los ids de panel salen de `GET $API/installations/$INST/panels`.

```bash
export PANEL=<panel-id>
curl -s -X POST $API/installations/$INST/controls \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"holder_id\":\"$HOLDER\",\"buttons\":[{\"button\":0,\"rf_code\":9876543,\"outputs\":{\"$PANEL\":0}}]}"
```

`PUT .../controls/{controlId}` reemplaza titular, descripción y los botones enviados (con `id` se edita un botón existente; sin `id` es nuevo); los botones que no vienen no se tocan. En `PUT` la `description` es **obligatoria** (sin ella, `400`): envía la actual para conservarla o `""` para dejarla vacía. En `POST` es opcional.

### Perfiles y reglas

```bash
curl -s -X POST $API/installations/$INST/profiles \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"name":"Residentes"}'

# Asignar titulares (deja el perfil con exactamente esos titulares)
curl -s -X PUT $API/installations/$INST/profiles/<profile-id>/holders \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"holder_ids\":[\"$HOLDER\"]}"

# Reglas por panel (rule: null quita el acceso en ese panel)
curl -s -X PUT $API/installations/$INST/profiles/<profile-id>/rules \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "[{\"panel_id\":\"$PANEL\",\"rule\":{\"output_mask\":3,\"card_reader_mask\":15,\"pin_reader_mask\":15,\"allow_rf\":true,\"allow_remote\":false,\"weekday_mask\":127,\"start_minute\":0,\"end_minute\":1439}}]"
```

Las máscaras de salidas y lectores tienen un bit por cada S1 a S4 y L1 a L4 (bit 0 = S1 o L1); `weekday_mask` tiene el bit 0 en lunes.

`allow_remote` (permite la apertura remota) y `allow_call` (permite abrir llamando) son opcionales al escribir: si se omiten, se conserva el valor actual (`false` en una regla nueva); las respuestas siempre los traen. En los logs, el origen `4` es "Remota" y el motivo `11` es "Titular desconocido".

### Apertura remota

`POST .../outputs/{outputId}/open` pide al panel abrir la salida a nombre de un titular y espera su confirmación hasta 8 s (la orden vence a los 10 s). El panel decide con el permiso del titular: la regla debe tener `allow_remote: true` e incluir la salida, el día y la hora. `requested_by` (de 1 a 120 caracteres, sin caracteres de control) queda en el log del panel, con origen `4` (Remota).

```bash
curl -s -X POST $API/installations/$INST/outputs/<output-id>/open \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: abrir-0001" \
  -H "Content-Type: application/json" \
  -d "{\"holder_id\":\"$HOLDER\",\"requested_by\":\"Caseta norte\"}"
# → 200 {"data":{"command_id":"…","status":"opened","reason":0,"detail":"Salida abierta"}}
```

No es un alta: responde `200` y el resultado va en `status`:

| `status` | Cuándo |
|---|---|
| `opened` | El panel abrió la salida (`reason` 0) |
| `denied` | El panel la rechazó: `reason` 2 (salida inexistente o deshabilitada), 3 (sin permiso) u 11 (titular desconocido) |
| `failed` | Otro error del panel, como la salida ya en uso (`reason` 0) o el relevador (`reason` 4) |
| `timeout` | Sin confirmación en 8 s; `reason` y `detail` son `null` |

**`timeout` no garantiza que la salida siga cerrada:** la orden vence a los 10 s y la API deja de esperar a los 8 s, así que el panel pudo abrirla después. Revisa los logs (origen `4`) antes de insistir. Un reintento con **otra** `Idempotency-Key` (o sin ella) es una orden nueva y puede abrir de nuevo.

Errores: `400` si el titular no existe en la instalación (o está borrado), `404` si la salida no existe, `409` "Panel sin conexión" si el panel está fuera de línea o no activo, `409` "La salida ya tiene una orden en curso." y `502 bad_gateway` solo si EMQX rechazó el mensaje (no se entregó, así que reintentar es seguro). Si la publicación falla por red o tiempo agotado, la orden pudo llegar al panel: la API no responde `502`, sigue esperando y responde `200` con el resultado o con `timeout`. Con `Idempotency-Key`, la respuesta se guarda al terminar la espera: un reintento devuelve el mismo resultado sin volver a abrir. Si el reintento con la misma llave llega mientras la primera petición sigue esperando, responde `409` "La petición original sigue en curso." y no publica otra orden.

- **Requiere paneles v7.** Un panel v6 ignora la orden y la API responde `timeout`.
- **Ventana de revocación:** si se quita `allow_remote` en la nube, el panel sigue abriendo con el permiso anterior hasta que sincroniza. Consulta `GET .../sync-status` para saber si los paneles ya aplicaron el cambio.

### Lecturas

- `GET /installations`, `GET /installations/{id}`, `GET .../panels`, `GET .../outputs`.
- `GET .../logs`: páginas de 50, del más reciente al más viejo. Filtros: `desde`, `hasta` (`AAAA-MM-DD`), `panel`, `titular`, `resultado` (`permitido` o `denegado`), `origen` (`0` tarjeta, `1` control RF, `2` botón, `3` PIN, `4` remota, `5` prueba o `6` llamada) y `pagina`. Responde `{data, page, page_size, total}`. Un filtro inválido da `400`. Los logs de PIN llevan `code: null`. La nube conserva los logs 30 días (un trabajo diario borra los más viejos) y no guarda intentos de controles RF desconocidos (motivo `5`, ya no se registra); si un admin usa "Borrar logs", los anteriores a esa purga tampoco vuelven a subirse.

## Pendiente

- **Etapa 2B:** webhooks.
