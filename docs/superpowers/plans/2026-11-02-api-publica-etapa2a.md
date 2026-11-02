# API pública, etapa 2A (REST con llaves de API) — Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans. Los pasos usan casillas (`- [ ]`).

**Objetivo:** una API REST en `/api/v1` para que una app externa del tenant consulte y administre titulares, tarjetas, controles por panel, PIN, perfiles, salidas, logs, instalaciones y paneles, autenticada con llaves de API.

**Arquitectura:**
- La API reutiliza las funciones `*As` de `cloud/src/lib`. Para eso, la guarda de acceso acepta además de un cliente con sesión un **actor de API** (`ApiActor`). Con un actor de API, las consultas usan la llave secreta de Supabase, cada una filtrada de forma explícita por `installation_id` o `tenant_id`, y las escrituras firman `updated_by = 'api:<id de la llave>'` **[decisión de Claude]**.
- Cada ruta pasa por `apiRoute`, que hace cuatro cosas:
  1. verifica el `Authorization: Bearer`;
  2. aplica el límite de peticiones;
  3. aplica `Idempotency-Key` en las escrituras;
  4. traduce los errores a `{code, message}`.
- Las escrituras ya disparan la sincronización por el trigger de revisión (`installations_notify_revision`), así que la API solo devuelve la revisión.

**Stack:** Next.js 16.4.3 (route handlers, Cache Components), Supabase con Postgres, RLS y pgTAP, Zod 4.6.7 y Vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-plataforma-nube-design.md`, sección 8, que es la autoridad, más los controles por panel de `docs/superpowers/specs/2026-10-30-controles-por-panel-logs-y-prueba-de-salidas-design.md`, sección 3. Los **webhooks** de la sección 8 son la **etapa 2B** y van en otro plan. "Borrar logs" está en pausa.

## Global Constraints

- **Git:** sin commits ni merges. Todo queda sin confirmar en `develop`.
- **Idioma:** mensajes, interfaz y comentarios en español.
- **Formato de errores:** `{"code": "<código estable>", "message": "<texto en español>"}`. Los códigos se derivan del estado HTTP igual que `CODIGO_POR_ESTADO` de `cloud/src/lib/device/http.ts`, más tres propios: `invalid_api_key`, `rate_limited` e `idempotency_mismatch`.
- **Llave de API:**
  - formato `acc_` + 43 caracteres base64url (32 bytes aleatorios);
  - solo se guarda su sha256 en hexadecimal y un prefijo visible con los primeros 12 caracteres;
  - se muestra completa **una sola vez**, al crearla;
  - máximo **10** llaves vivas por tenant **[decisión de Claude]**.
- **Alcance y rol:** una llave actúa como **admin** del tenant en todas sus instalaciones **[decisión de Claude]**. Una instalación o recurso de otro tenant responde **404**, nunca 403, para no revelar que existe.
- **Límite de peticiones:** **120 por minuto por llave** **[decisión de Claude]**. Al pasarlo responde 429 `rate_limited` con el encabezado `Retry-After`.
- **`Idempotency-Key`:**
  - es opcional y aplica a `POST`, `PATCH`, `PUT` y `DELETE`;
  - mide de 1 a 200 caracteres y dura 24 h;
  - la misma llave con el mismo cuerpo devuelve la respuesta guardada;
  - con otro cuerpo responde 422 `idempotency_mismatch`;
  - si la petición original sigue en curso, responde 409 `conflict`.
- **Respuesta de las escrituras:** `{"data": …, "revision": <installations.revision después de escribir>}`.
- **El PIN** nunca aparece en logs ni en las respuestas de lectura; las lecturas exponen `has_pin`. Solo se devuelve una vez, en la respuesta de "generar PIN".
- **Migraciones:**
  - se crean con `cd cloud && npx supabase migration new <nombre>` y se prueban solo en local;
  - toda tabla nueva lleva RLS, GRANT por columna y `revoke` a `anon` y `authenticated` cuando solo la usa el servidor.
- **Pruebas:** `cd cloud && npm test && npm run test:db && npm run lint && npx tsc --noEmit && npm run build`.

## Review Focus

1. **Aislamiento entre tenants con la llave secreta.** Con la llave del tenant A y el id de un titular, control, perfil o panel del tenant B (en la ruta o en el cuerpo, por ejemplo `holder_id` de una tarjeta o `panel_id` de un botón), la respuesta es 404 o 400 y no cambia nada. Lo cubren pruebas en las Tareas 1, 5, 6 y 7.
2. **Llave revocada o rotada.** Responde 401 `invalid_api_key` de inmediato (Tareas 2 y 3).
3. **Reintento con la misma `Idempotency-Key`** después de que la primera respuesta fue un error 4xx. Se devuelve el mismo error guardado; solo los 5xx no se guardan, para permitir el reintento (Tarea 3).
4. **Cuerpo que no es JSON o con campos de más.** Responde 400 con un mensaje en español que nombra el campo (Tareas 3 y 5).
5. **Autoría.** Una escritura por la API queda firmada `api:<id>` en `audit_log`, y una escritura por la interfaz sigue firmando `user:<uid>` (Tarea 1).

---

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `cloud/src/lib/auth/guards.ts`, `cloud/src/lib/access-data.ts` | `ApiActor`, `DataClient` y la guarda que acepta los dos tipos de actor; `autoria()` |
| `cloud/src/lib/{holders,cards,controls,profiles,outputs,logs,installations}.ts`, `cloud/src/lib/panels/list.ts` | Aceptar `DataClient`, firmar las escrituras y filtrar cada consulta explícitamente |
| migración `api_keys` (nueva) | Tablas `api_keys`, `api_requests` y `api_idempotency` |
| `cloud/src/lib/api/keys.ts` (nuevo) | Crear, listar, revocar, rotar y verificar llaves |
| `cloud/src/lib/api/http.ts` (nuevo) | `apiRoute`, `ApiError`, `apiJson`, `readApiBody`, `readApiQuery`, límite de peticiones e idempotencia |
| `cloud/src/app/api/v1/**/route.ts` (nuevos) | Rutas REST |
| `cloud/src/lib/api/openapi.ts` y `cloud/src/app/api/v1/openapi.json/route.ts` (nuevos) | Documento OpenAPI 3.1 |
| `cloud/src/app/t/[tenant]/api/{page,actions}.ts(x)` y `cloud/src/components/api/ApiKeysManager.tsx` (nuevos) | Pantalla de llaves, solo para admin |
| `cloud/docs/api.md` (nuevo) | Guía de uso de la API |

---

### Tarea 1: La capa de datos acepta un actor de API

**Archivos:**
- Modificar: `cloud/src/lib/auth/guards.ts`, `cloud/src/lib/access-data.ts` y todas las funciones `*As` de `holders.ts`, `cards.ts`, `controls.ts`, `profiles.ts`, `outputs.ts`, `logs.ts`, `installations.ts` y `panels/list.ts`.
- Pruebas: nuevo `cloud/tests/ui/api-actor.test.ts`. Las pruebas existentes deben seguir en verde.

**Interfaces:**
- `export interface ApiActor { kind: "api"; tenantId: string; keyId: string; keyName: string }`.
- `export type DataClient = SupabaseClient | ApiActor`. Todas las funciones `*As` cambian el tipo de su primer parámetro de `SupabaseClient` a `DataClient`. La interfaz web sigue pasando el cliente con sesión.
- `requireTenantRole(tenantId, role, supabase?: DataClient)`:
  - con un `ApiActor`, si `actor.tenantId !== tenantId` lanza `HttpError(404, "La instalación no existe.")` cuando viene de `requireInstallationAccess`, o 404 genérico en otro caso;
  - si coincide, devuelve `TenantAccess` con `supabase = createAdminSupabase()`, `userId = null`, `email = "api:" + keyName`, `role = "admin"` y `actor`.
  - `TenantAccess` suma `actor?: ApiActor`, y `userId` pasa a `string | null`. Ajusta a los consumidores.
- `export function autoria(acceso: TenantAccess): Record<string, string>`:
  - devuelve `{}` con un usuario, porque el trigger firma;
  - con un `ApiActor` devuelve `{ updated_by: "api:" + keyId, origin: "cloud", updated_at: new Date().toISOString() }`.
- Toda inserción o actualización en tablas replicadas (`holders`, `cards`, `controls`, `control_buttons`, `control_button_panels`, `access_profiles`, `holder_profiles`, `profile_panel_rules` y `outputs`) suma `...autoria(acceso)`, incluidos los borrados lógicos y las compensaciones.
- **Filtro explícito:** las consultas que hoy dependen solo de RLS (`controls.ts:223,384,425,434,522,545,556,564`, `profiles.ts:209,285-308,335,347` y `panels/list.ts`) se filtran explícitamente por `installation_id` o por el padre ya verificado. `listPanelsAs(supabase, installationId)` pasa a `listPanelsAs(client: DataClient, tenantId: string, installationId: string)` con `requireInstallationAccess(..., "tecnico")`; actualiza a quienes lo llaman.

- [ ] **Paso 1: escribir `api-actor.test.ts`**, contra el Supabase local, con dos tenants A y B:
  - con `ApiActor` de A, `createHolderAs` crea el titular, y el `updated_by` del titular y de `audit_log` es `api:<keyId>`, con `origin = 'cloud'`;
  - `createCardAs` de A con `holder_id` de B responde 400 o 404 y no crea nada;
  - `updateControlAs` de A con `panel_id` de B en `outputs` responde 400, sin cambios;
  - `renameProfileAs` de A sobre el id de un perfil de B, pasando la instalación de A, responde 404, y el perfil de B no cambia;
  - `listPanelsAs` de A con la instalación de B responde 404;
  - un `ApiActor` de A contra cualquier función con `tenantId = B` responde 404;
  - `getHolderPinAs` con `ApiActor` funciona, porque la llave actúa como admin.
- [ ] **Paso 2:** `cd cloud && npx vitest run tests/ui/api-actor.test.ts` debe **fallar**.
- [ ] **Paso 3:** implementar según las interfaces.
- [ ] **Paso 4:** `npm test && npx tsc --noEmit && npm run lint` en verde. La suite existente demuestra que la interfaz no cambió.

### Tarea 2: Llaves de API (tablas, librería y pgTAP)

**Archivos:**
- Crear: la migración `api_keys`, `cloud/supabase/tests/api_keys.test.sql`, `cloud/src/lib/api/keys.ts` y `cloud/tests/api/keys.test.ts`.

**Interfaces:**
- **SQL:**
  - `public.api_keys`: `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null references tenants on delete cascade`, `name text not null check (char_length(name) between 1 and 60)`, `prefix text not null`, `key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$')`, `created_at timestamptz not null default now()`, `created_by uuid`, `last_used_at timestamptz` y `revoked_at timestamptz`. RLS con `select` para `private.is_tenant_admin(tenant_id)`, solo de las columnas sin `key_hash`. Sin escrituras desde el cliente.
  - `public.api_requests(key_id uuid not null references api_keys on delete cascade, at timestamptz not null default now())`, con índice `(key_id, at)`. Solo la usa `service_role`.
  - `public.api_idempotency(key_id uuid not null references api_keys on delete cascade, idem_key text not null, request_hash text not null, status int, response jsonb, created_at timestamptz not null default now(), primary key (key_id, idem_key))`. Solo la usa `service_role`.
- **`keys.ts`** (`server-only`):
  - `createApiKeyAs(supabase, tenantId, name): Promise<{ key: ApiKeyRow; secret: string }>`. Requiere admin. Si ya hay 10 llaves vivas, lanza 409 "Ya hay 10 llaves activas; revoca alguna.".
  - `listApiKeysAs(supabase, tenantId): Promise<ApiKeyRow[]>`, con `ApiKeyRow = {id, name, prefix, created_at, last_used_at, revoked_at}`.
  - `revokeApiKeyAs(supabase, tenantId, keyId): Promise<void>`.
  - `rotateApiKeyAs(supabase, tenantId, keyId): Promise<{ key: ApiKeyRow; secret: string }>`. Crea una llave con el mismo nombre y revoca la anterior en el mismo paso.
  - `verifyApiKey(secret: string): Promise<ApiActor | null>`. Compara por hash, ignora las revocadas y las de tenants suspendidos, y actualiza `last_used_at` como máximo una vez por minuto.

- [ ] **Paso 1: escribir las pruebas.**
  - **pgTAP:** un admin ve las llaves de su tenant sin `key_hash`; un técnico y alguien de otro tenant no las ven; `authenticated` no puede insertar en ninguna de las tres tablas.
  - **Vitest:**
    - crear devuelve un secreto `acc_` de 47 caracteres que `verifyApiKey` resuelve;
    - una llave revocada da `null`;
    - rotar invalida la anterior y la nueva funciona;
    - la llave número 11 da 409;
    - un técnico da 403;
    - un tenant suspendido da `null`.
- [ ] **Paso 2:** confirmar que **fallan**.
- [ ] **Paso 3:** implementar y aplicar `npx supabase migration up --local`.
- [ ] **Paso 4:** `npm run test:db && npx vitest run tests/api/keys.test.ts`, más los advisors sin avisos nuevos.

### Tarea 3: Núcleo HTTP de la API (autenticación, límite, idempotencia, errores)

**Archivos:**
- Crear: `cloud/src/lib/api/http.ts`, `cloud/tests/api/http.test.ts` y la ruta de prueba `cloud/src/app/api/v1/me/route.ts` (`GET`, devuelve `{tenant_id, key: {id, name, prefix}}`).

**Interfaces:**
- `class ApiError extends HttpError { constructor(status: number, readonly code: string, message: string) }`.
- `apiJson(body: unknown, status = 200, headers?: HeadersInit): Response`, con `cache-control: no-store`.
- `readApiBody<T>(req, schema: z.ZodType<T>): Promise<T>`, que responde 400 `bad_request` nombrando el campo, igual que `readJsonBody` de dispositivos.
- `readApiQuery<T>(req, schema): T`, que responde 400 `bad_request`.
- `apiRoute(req: Request, handler: (actor: ApiActor) => Promise<Response>): Promise<Response>`:
  1. lee `Authorization: Bearer <secreto>`; si falta o no es válida, responde 401 `invalid_api_key` "Llave de API inválida o revocada.";
  2. aplica el límite de peticiones con inserción y conteo en `api_requests`, como `reservarIntento` de `panels/claim.ts`, en una ventana de 60 s; borra las filas viejas de esa llave; si se pasa de 120, responde 429 `rate_limited` "Demasiadas peticiones; espera un momento." con `Retry-After: 60`;
  3. para `POST`, `PATCH`, `PUT` y `DELETE` con `Idempotency-Key`:
     - `request_hash` = sha256 de método + ruta + cuerpo;
     - si la llave es nueva, inserta una fila con `status` nulo;
     - si la fila ya tiene respuesta y el hash coincide, devuelve la respuesta guardada con el encabezado `Idempotent-Replayed: true`;
     - si el hash no coincide, responde 422 `idempotency_mismatch` "La Idempotency-Key ya se usó con otra petición.";
     - si `status` es nulo y la fila tiene menos de 60 s, responde 409 "La petición original sigue en curso.";
     - guarda el resultado cuando no es 5xx; con 5xx borra la fila;
     - borra las filas de más de 24 h de esa llave;
  4. ejecuta `handler(actor)`; los `HttpError` se traducen con el mapa de códigos y cualquier otro error da 500 `internal_error` con un `console.error` limpio, igual que `deviceRoute`;
  5. aplica `unstable_rethrow` primero.

- [ ] **Paso 1: escribir `http.test.ts`**, llamando a `GET /api/v1/me` y a una ruta `POST` de prueba registrada solo en la prueba:
  - sin encabezado, con una llave inválida o con una llave revocada: 401 `invalid_api_key`;
  - la petición 121 en un minuto da 429 con `Retry-After`; baja el límite con un objeto exportado `limits` para la prueba;
  - con la misma `Idempotency-Key`, el handler corre una sola vez y la segunda respuesta lleva `Idempotent-Replayed: true`;
  - con otro cuerpo: 422;
  - un 4xx guardado se repite igual; un 5xx no se guarda;
  - un cuerpo que no es JSON da 400 `bad_request`;
  - un `HttpError(404)` del handler da `{code:"not_found", message}`.
- [ ] **Paso 2:** confirmar que **fallan**.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npx vitest run tests/api && npx tsc --noEmit`.

### Tarea 4: Rutas de lectura (instalaciones, paneles, estado de sincronización, salidas y logs)

**Archivos:**
- Crear: rutas en `cloud/src/app/api/v1/installations/route.ts`, `installations/[installationId]/route.ts`, `.../panels/route.ts`, `.../sync-status/route.ts`, `.../outputs/route.ts` y `.../logs/route.ts`.
- Pruebas: `cloud/tests/api/read.test.ts`.

**Interfaces:**
- `GET /api/v1/installations` responde `{data: [{id, name, revision}]}`.
- `GET /api/v1/installations/{id}` responde `{data: {id, name, revision}}`.
- `GET .../panels` responde `{data: [{id, panel_code, status, online, last_sync_at, synced_revision, software_version}]}`.
- `GET .../sync-status` responde `{data: {revision, panels: [{id, panel_code, online, synced_revision, applied: synced_revision >= revision}]}}`, solo con los paneles vinculados (`isLinkedPanel`).
- `GET .../outputs` responde `{data: [{id, panel_id, output_index, alias, duration_ms, reader_mask, enabled}]}`.
- `GET .../logs?desde&hasta&panel&titular&resultado&origen&pagina` usa los mismos nombres y validación que `parseLogFilters`, y responde `{data: rows, page, page_size: 50, total}`.
- Todas usan `apiRoute` y las funciones `*As` con el actor.

- [ ] **Paso 1:** escribir `read.test.ts`:
  - cada ruta con la llave de A devuelve solo datos de A;
  - la instalación de B da 404;
  - `sync-status` marca `applied: false` cuando `synced_revision < revision`;
  - los logs filtran por `origen=5` y paginan.
- [ ] **Paso 2:** confirmar que **fallan**.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npx vitest run tests/api/read.test.ts`.

### Tarea 5: Titulares y PIN

**Archivos:**
- Crear: `cloud/src/app/api/v1/installations/[installationId]/holders/route.ts` (`GET`, `POST`), `.../holders/[holderId]/route.ts` (`GET`, `PATCH`, `DELETE`) y `.../holders/[holderId]/pin/route.ts` (`PUT`, `DELETE`).
- Crear también `cloud/src/lib/pin.ts`, con `generatePin(): string` (6 dígitos con `crypto.randomInt(0, 1_000_000)` y ceros a la izquierda).
- Pruebas: `cloud/tests/api/holders.test.ts`.

**Interfaces:**
- **Cuerpos:** `POST` y `PATCH` reciben los mismos campos que `HolderInput`, **sin** PIN. En `PATCH`, los campos que no vienen se conservan: lee el titular y combínalo antes de `updateHolderAs`.
- **Respuestas:** `{data: HolderRow, revision}`; `DELETE` responde `{data: {id}, revision}`.
- **`PUT .../pin`** recibe `{pin: "1234"}` (de 4 a 6 dígitos) o `{generate: true}`, y usa `updateHolderAs` con `PinChange`.
  - Con `generate`, intenta hasta 5 PIN distintos si el elegido ya existe (409 por PIN repetido) y responde `{data: {pin}, revision}`.
  - Con `pin`, responde `{data: {has_pin: true}, revision}`.
- **`DELETE .../pin`** usa `{mode: "clear"}`.
- **Revisión:** después de escribir, la respuesta lleva la `revision` actual de la instalación. Agrega el auxiliar `currentRevision(installationId)` en `cloud/src/lib/api/revision.ts`.

- [ ] **Paso 1:** escribir `holders.test.ts`:
  - CRUD completo, donde la `revision` sube en cada escritura y `has_pin` cambia con `PUT/DELETE pin`;
  - `generate` devuelve 6 dígitos que se pueden descifrar con `getHolderPinAs`, y ninguna lectura devuelve el PIN;
  - un PIN repetido da 409;
  - un campo extra en el cuerpo da 400;
  - el titular de B da 404;
  - `PATCH` con un solo campo conserva los demás.
- [ ] **Paso 2:** confirmar que **fallan**.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npx vitest run tests/api/holders.test.ts`.

### Tarea 6: Tarjetas y controles por panel

**Archivos:**
- Crear: `.../cards/route.ts` (`GET`, `POST`), `.../cards/[cardId]/route.ts` (`PATCH`, `DELETE`), `.../controls/route.ts` (`GET`, `POST`) y `.../controls/[controlId]/route.ts` (`GET`, `PUT`, `DELETE`).
- Pruebas: `cloud/tests/api/cards-controls.test.ts`.

**Interfaces:**
- **Tarjetas:** usan los campos de `CardInput`; `PATCH` combina con el registro actual.
- **Controles:**
  - el cuerpo es `ControlInput`, con `buttons: [{id?, button, rf_code, outputs: {<panel_id>: 0..3 | null | "sin_salida"}}]`, igual que la interfaz;
  - `PUT` reemplaza los botones enviados, con la semántica de `updateControlAs`: los paneles que no vienen no se tocan;
  - el `GET` devuelve `ControlRow` con `outputs` por panel.
- **Respuestas:** `{data, revision}`.

- [ ] **Paso 1:** escribir `cards-controls.test.ts`:
  - una tarjeta con un código repetido da 409;
  - un control con un botón al Panel 1 en S1 y "Ninguna" en el Panel 2 crea un solo vínculo;
  - un `panel_id` de otro tenant da 400;
  - el mismo número de botón en el mismo panel da 409, porque se traduce la unicidad por panel;
  - el control de B da 404.
- [ ] **Paso 2:** confirmar que **fallan**.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npx vitest run tests/api/cards-controls.test.ts`.

### Tarea 7: Perfiles, reglas y asignación

**Archivos:**
- Crear: `.../profiles/route.ts` (`GET`, `POST`), `.../profiles/[profileId]/route.ts` (`PATCH`, solo `name`; `DELETE`), `.../profiles/[profileId]/rules/route.ts` (`PUT`) y `.../profiles/[profileId]/holders/route.ts` (`PUT`, con `{holder_ids: string[]}`).
- Pruebas: `cloud/tests/api/profiles.test.ts`.

**Interfaces:**
- Usan `createProfileAs`, `renameProfileAs`, `deleteProfileAs`, `saveProfileRulesAs` y `setProfileHoldersAs`, con los mismos cuerpos que la interfaz.
- El `GET` devuelve `ProfileRow`, con las reglas por panel y los titulares.
- Las respuestas de escritura son `{data, revision}`.

- [ ] **Paso 1:** escribir `profiles.test.ts`:
  - crear, guardar reglas para dos paneles y asignar titulares;
  - un `holder_id` de B en `holder_ids` da 400 o 404 sin cambios;
  - una regla con `panel_id` de B da 400;
  - borrar un perfil le quita la asignación a sus titulares.
- [ ] **Paso 2:** confirmar que **fallan**.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npx vitest run tests/api/profiles.test.ts`.

### Tarea 8: Documento OpenAPI

**Archivos:**
- Crear: `cloud/src/lib/api/openapi.ts` (`export const openapi: object`, OpenAPI 3.1 escrito a mano) y `cloud/src/app/api/v1/openapi.json/route.ts` (`GET` público, sin llave).
- Pruebas: `cloud/tests/api/openapi.test.ts`.

**Interfaces:**
- El documento describe cada ruta de las Tareas 3 a 7: método, parámetros, cuerpo, respuestas, `Idempotency-Key` y el esquema de error `{code, message}`.
- Esquema de seguridad: `bearerAuth` (HTTP bearer).
- Descripciones en español.

- [ ] **Paso 1:** escribir `openapi.test.ts`:
  - recorre `cloud/src/app/api/v1/**/route.ts` y sus métodos exportados, y exige que cada pareja (ruta, método) esté en `openapi.paths`, salvo `openapi.json`;
  - el documento es JSON válido con `openapi: "3.1.0"`.
- [ ] **Paso 2:** confirmar que **falla**.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npx vitest run tests/api/openapi.test.ts`.

### Tarea 9: Pantalla de llaves de API (solo admin)

**Archivos:**
- Crear: `cloud/src/app/t/[tenant]/api/page.tsx`, `cloud/src/app/t/[tenant]/api/actions.ts` y `cloud/src/components/api/ApiKeysManager.tsx`.
- Modificar: `cloud/src/app/t/[tenant]/sections.ts`, para sumar `{segment: "api", label: "API", minRole: "admin"}`.
- Pruebas: `cloud/tests/ui/api-keys.test.tsx`.

**Interfaces:**
- **Página:** usa `guardPage(listApiKeysAs(...))`, siguiendo el patrón de `users/page.tsx`, con `export const instant = false` y `metadata`.
- **Acciones:** `createApiKey(tenantId, name)`, `revokeApiKey(tenantId, keyId)` y `rotateApiKey(tenantId, keyId)`, con `z.tuple` y `runAction`.
- **Interfaz:**
  - una tabla con el nombre, el prefijo, el alta, el último uso y el estado;
  - un formulario "Nueva llave";
  - al crear o rotar, un aviso con el secreto, un botón "Copiar" y el texto "Guárdala ahora: no se volverá a mostrar.";
  - "Revocar" y "Rotar" piden confirmar con `window.confirm`;
  - un enlace a `/api/v1/openapi.json`.
- Usa las skills `frontend-design` y `vercel-react-best-practices` y las clases existentes.

- [ ] **Paso 1:** escribir `api-keys.test.tsx`:
  - crear muestra el secreto una sola vez y, al recargar la lista, ya no está;
  - revocar pide confirmación;
  - la pestaña "API" no aparece para un técnico.

  Además, en `tests/ui`, una prueba de datos: un técnico que llama a la acción recibe 403.
- [ ] **Paso 2:** confirmar que **fallan**.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npm test && npm run lint && npx tsc --noEmit && npm run build`.

### Tarea 10: Documentación y verificación

**Archivos:**
- Crear: `cloud/docs/api.md`. Debe cubrir:
  - cómo crear una llave;
  - autenticación, errores, idempotencia y límites;
  - ejemplos `curl` de titular, PIN generado, control por panel y estado de sincronización;
  - el enlace a OpenAPI.
- Modificar: `CLAUDE.md` (Estado, etapa 2A, conteos de pruebas) y `cloud/docs/despliegue.md` (la migración nueva).

- [ ] **Paso 1:** escribir la documentación.
- [ ] **Paso 2:** correr la batería completa (`cd cloud && npm test && npm run test:db && npm run lint && npx tsc --noEmit && npm run build`) y además `bash cloud/e2e/run_e2e.sh`. Todo debe pasar.
