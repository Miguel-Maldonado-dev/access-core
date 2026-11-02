# API pública de Access Core (`/api/v1`)

API REST para administrar una instalación desde sistemas externos: titulares, tarjetas, PIN, controles, perfiles, y consulta de paneles, salidas, logs y estado de sincronización.

- **Base:** `https://<APP_URL>/api/v1` (en local, `http://localhost:3001/api/v1`).
- **OpenAPI 3.1:** `GET /api/v1/openapi.json` (público, sin llave). Es el contrato completo de rutas, cuerpos y respuestas.

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
| 429 | `rate_limited` | Más de 120 peticiones por minuto (trae `Retry-After`) |
| 500 | `internal_error` | Error interno |

## Límites

- **120 peticiones por minuto por llave.** Al pasarlo, `429` con `Retry-After` (segundos).

## Idempotencia

`Idempotency-Key` es opcional en `POST`, `PATCH`, `PUT` y `DELETE`: de 1 a 200 caracteres, vigente 24 h.

- Misma llave y mismo cuerpo: devuelve la respuesta guardada con el encabezado `Idempotent-Replayed: true`. También se repiten los errores 4xx; los 5xx no se guardan, así que se pueden reintentar.
- Misma llave con otro cuerpo (u otra ruta): `422 idempotency_mismatch`.
- Si la petición original sigue en curso: `409 conflict`.
- **Es por llave:** la `Idempotency-Key` se guarda con la llave que la usó. Después de rotar la llave, un reintento con la llave nueva y la misma `Idempotency-Key` se ejecuta de nuevo.
- **No se admite en las rutas de PIN** (`PUT` y `DELETE .../holders/{holderId}/pin`): responden `400` si se envía, para no guardar el PIN en la respuesta repetible.

```bash
curl -s -X POST $API/installations/$INST/holders \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: alta-lote-0001" \
  -H "Content-Type: application/json" \
  -d '{"kind":"persona","name":"Ana Pérez","department":"12B"}'
```

## Escrituras y sincronización

Las escrituras responden `{"data": …, "revision": <n>}`; los `POST` responden `201`. Cada escritura sube la revisión de la instalación y dispara la sincronización hacia los paneles. `revision` se lee después de escribir: con escrituras concurrentes puede ser mayor que la de la propia escritura, pero nunca retrocede.

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

Si otro titular de la instalación ya usa ese PIN, responde `409 conflict`. Es lo esperado (el PIN es único por instalación), y probar PIN de esta forma queda acotado por el límite de 120 peticiones por minuto. Para quitarlo:

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
  -d "[{\"panel_id\":\"$PANEL\",\"rule\":{\"output_mask\":3,\"card_reader_mask\":15,\"pin_reader_mask\":15,\"allow_rf\":true,\"weekday_mask\":127,\"start_minute\":0,\"end_minute\":1439}}]"
```

Las máscaras de salidas y lectores tienen un bit por cada S1 a S4 y L1 a L4 (bit 0 = S1 o L1); `weekday_mask` tiene el bit 0 en lunes.

### Lecturas

- `GET /installations`, `GET /installations/{id}`, `GET .../panels`, `GET .../outputs`.
- `GET .../logs`: páginas de 50, del más reciente al más viejo. Filtros: `desde`, `hasta` (`AAAA-MM-DD`), `panel`, `titular`, `resultado` (`permitido` o `denegado`), `origen` (`0`, `1`, `2`, `3` o `5`) y `pagina`. Responde `{data, page, page_size, total}`. Un filtro inválido da `400`. Los logs de PIN llevan `code: null`.

## Pendiente

- **Etapa 2B:** webhooks.
- **Etapa 3:** apertura remota.
