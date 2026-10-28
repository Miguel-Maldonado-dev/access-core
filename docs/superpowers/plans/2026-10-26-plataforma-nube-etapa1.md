# Plataforma en la nube — Etapa 1 (ver y sincronizar) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Objetivo:** construir la plataforma multi-tenant donde se vinculan paneles a instalaciones y se ven y editan sus datos, con sincronización en los dos sentidos entre la nube y cada panel, más la subida de logs. Abarca la nube y el agente nuevo del panel.

**Arquitectura:**
- **Nube:** un solo proyecto Next.js (App Router) en `cloud/` contiene:
  - la interfaz;
  - la API de dispositivos `/api/device/v1`;
  - los receptores del broker y de la base.

  Supabase guarda los datos con RLS por tenant y los usuarios (Auth). EMQX corre en Docker en un servidor pequeño.
- **Panel:** el esquema local pasa a **v6** (UUID, marcas de cambio y bandeja de salida con triggers). Un servicio nuevo, `acceso-cloud`, se registra, se vincula y sincroniza por HTTPS. Escucha avisos por MQTT y sube logs.
- **Sin cambios:** el daemon y la autorización local no se tocan.

**Tecnología:**
- **Nube:** Next.js (TypeScript, App Router, Server Actions), `@supabase/ssr`, `@supabase/supabase-js`, Supabase CLI (migraciones SQL, pgTAP con `supabase test db`), Vitest, Tailwind, EMQX 5 (Docker) y Node `crypto`.
- **Panel:** Python ≥3.9, `httpx` y `paho-mqtt` 2.x, ambos puros en Python, y pytest.

**Spec:** `docs/superpowers/specs/2026-10-26-plataforma-nube-design.md` (etapa 1). Esquema local de partida: `panel/backend/acceso/schema.py` (v5).

## Restricciones globales

- **Idioma y códigos:** interfaz y mensajes en español. Los códigos de tarjeta y RF se muestran en decimal.
- **El panel nunca depende de la nube para abrir:**
  - `acceso-cloud` es un proceso aparte;
  - el daemon y `access.py` no cambian;
  - el agente escribe con transacciones cortas `BEGIN IMMEDIATE` y respeta el `busy_timeout` de 5000 ms.
- **Repositorio y Git:**
  - todo vive en el repositorio `access-core`: la nube en `cloud/` y el panel en `panel/`;
  - se trabaja en la rama `develop`;
  - **ni el controlador ni los subagentes hacen commits ni merges**: los cambios quedan sin confirmar y el dueño los confirma y fusiona.
- **Entornos de Supabase [decisión de Claude]:**
  - las pruebas (pgTAP y Vitest) corren **solo** contra Supabase local (`supabase start`, con Docker) y nunca contra un proyecto remoto;
  - **Access-Core-DEV** (ref `dnwzvjrdzubvynsmuloh`) es el entorno remoto de desarrollo. El controlador le aplica las migraciones con el MCP de Supabase después de que pasan la revisión, y `cloud/.env.local` apunta a él;
  - los archivos de migración se crean con `supabase migration new <nombre>`, que les pone fecha y hora. Los nombres `0001_org.sql`, etc., de este plan son lógicos.
- **Llaves de Supabase [decisión de Claude]:** se usan las llaves nuevas: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`) en el navegador y `SUPABASE_SECRET_KEY` (`sb_secret_…`) solo en el servidor. No se usan `anon` ni `service_role` heredadas. En este plan, "`service_role`" significa el cliente con la llave secreta.
- **Exposición a la Data API [decisión de Claude]:** las tablas nuevas de `public` ya no quedan expuestas por defecto (cambio de Supabase del 2026-04-28). Cada migración da `GRANT` explícitos a `authenticated` solo en las tablas que la interfaz usa, siempre con RLS activa, y nunca a `anon`.
- **Funciones auxiliares de RLS [decisión de Claude]:** las funciones `security definer` van en un esquema `private`, que no se expone, con `set search_path = ''`. Se revoca `EXECUTE` a `public` y se da solo a `authenticated` (y a `service_role` cuando haga falta).
- **Constantes de sincronización:**

  | Constante | Valor |
  |---|---|
  | `SYNC_INTERVAL_S` | 300 |
  | `RECONCILE_INTERVAL_S` | 86400 |
  | `OUTBOX_POLL_S` | 5 |
  | `LOG_BATCH` | 500 |
  | `CHANGES_PAGE` | 500 |
  | `MASS_DELETE_RATIO` | 0.20 |
  | `MASS_DELETE_MIN` (con menos borrados nunca se bloquea) | 10 |
  | `CONFIRM_DELETIONS_WINDOW_S` (vigencia de "Confirmar borrados") | 3600 |
  | `MAX_CLOCK_SKEW_S` | 300 |
  | retención de logs en la nube | 12 meses |
  | máximo de perfiles por instalación | 32 |

- **Identidad del panel:**
  - `panel_code` con formato `PNL-XXXX-XXXX`;
  - código de vinculación de **8** caracteres;
  - ambos usan el alfabeto Crockford base32 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, generado con `secrets`;
  - `panel_secret`: 32 bytes en hexadecimal, que nunca sale del panel salvo en `/activate`;
  - `device_token`: 32 bytes en base64url.

  La nube guarda solo `sha256` de `claim_code`, `panel_secret` y `device_token`.
  - **[decisión de Claude]** Cada hash es `sha256` en hexadecimal minúsculo del **texto** en UTF-8, tal como viaja: `claim_code` en mayúsculas, `panel_secret` como sus 64 caracteres hexadecimales en minúsculas y `device_token` en base64url. Nunca se hashean los bytes decodificados.
- **Tópicos MQTT:**
  - `acc/<panel_code>/cmd` (nube → panel; payload `{"type":"sync","revision":N}`);
  - `acc/<panel_code>/evt` (panel → nube);
  - `acc/<panel_code>/status`, retenido y LWT, con `"online"` u `"offline"`.

  Usuario MQTT = `panel_code` y contraseña = `device_token`.
- **Autenticación de dispositivo en HTTPS:** `Authorization: Device <panel_code>.<device_token>`.
- **PIN en la nube:**
  - se cifra con AES-256-GCM (`PIN_ENC_KEY`, 32 bytes en base64), con formato `base64(iv12|tag16|ciphertext)`;
  - la unicidad se comprueba con `pin_lookup = HMAC-SHA256(PIN_LOOKUP_KEY, installation_id + ":" + pin)` en hexadecimal;
  - nunca aparece en listas, logs, webhooks ni auditoría.
- **Vocabulario del contrato de dispositivo:** coincide con las tablas locales del panel: `holders`, `cards`, `controls`, `control_buttons`, `permissions`, `holder_permissions` y `outputs`. La nube **proyecta** perfil + regla de *ese* panel → `permissions`, `holder_profiles` → `holder_permissions`, y las salidas de *ese* panel → `outputs`.
- **Roles:** súper administrador en la tabla `platform_admins`; roles de tenant `admin` y `tecnico`.

## Contrato de la API de dispositivos (`/api/device/v1`)

Lo usan las tareas N5–N9 (nube) y P2–P4 (panel). Fechas en ISO-8601 UTC con milisegundos; UUID en minúsculas. `data` usa los nombres de columnas locales; las referencias entre registros van por UUID.

| Método y ruta | Auth | Petición | Respuesta |
|---|---|---|---|
| `POST /register` | ninguna | `{panel_code, claim_code_hash, panel_secret_hash, software_version, schema_version}` | `201 {status:"pending"}` · mismo `panel_secret_hash`: si está `pending` actualiza `claim_code_hash`; si está `revoked` vuelve a `pending` sin instalación; en otro estado no cambia nada; responde `200 {status}` · `409` si otro secreto |
| `POST /activate` | ninguna | `{panel_code, panel_secret}` | `202 {status:"pending"}` · `200 {device_token, installation_id, installation_name}` (una sola vez; pasa a `staging`) · `410` revocado |
| `GET /link-state` | Device | — | `{status:"staging"\|"awaiting_review"\|"active"}` · un panel revocado ya no tiene credencial y recibe `401`, que el agente trata como revocación **[decisión de Claude]** |
| `POST /import-snapshot` | Device | `{tables:{<tabla>:[{id,data}]}}` (todas las tablas replicadas) | `202 {status:"awaiting_review"\|"active"}` |
| `GET /changes?since=R&limit=500` | Device | — | `{revision, has_more, confirm_deletions, changes:[{table, op:"upsert"\|"delete", id, revision, data?}]}` ordenado por `revision` |
| `POST /changes` | Device | `{changes:[{change_id, table, op, id, updated_at, data?}]}` | `{revision, results:[{change_id, status:"applied"\|"superseded"\|"rejected", revision?, reason?, current?}]}` — `current` viene cuando lo que quedó en la nube difiere de lo enviado: `{data}` con la versión vigente para ese panel, o `null` si el registro no existe |
| `POST /logs` | Device | `{logs:[{local_log_id, timestamp, allowed, source, reason, holder_id, holder_name, holder_kind, credential_label, control_id, code, device_id, output_id}]}` | `{accepted, last_local_log_id}` |
| `GET /checksums` | Device | — | `{revision, confirm_deletions, tables:{<tabla>:"<sha256 hex>"}}` |
| `GET /snapshot?table=T` | Device | — | `{revision, rows:[{id,data}]}` |
| `POST /alerts` | Device | `{type:"mass_delete_blocked", table, would_delete, total}` | `204` |

**Forma de `data` por tabla:**
- `holders`: `{kind, name, department, address, notes, pin|null}`
- `cards`: `{card_code, holder_id, description}`
- `controls`: `{holder_id, description}`
- `control_buttons`: `{control_id, button, rf_code, output_id|null}`
- `permissions`: `{permission_id, name, output_mask, card_reader_mask, pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute}`
- `holder_permissions`: `{holder_id, permission_id}`
- `outputs`: `{output_id, alias, duration_ms, reader_mask, enabled}`

**Identificadores:**
- `id` de `permissions` = `access_profiles.id`;
- `id` de `holder_permissions` = `holder_profiles.id`;
- `id` de `outputs` = el `outputs.id` de la nube de ese panel.

**Valores que no son UUID:** `permission_id` (0..31) es el `local_permission_id` del perfil, y `output_id` (0..3) es `output_index`.

`confirm_deletions` es verdadero mientras `panels.confirm_deletions_until > now()`.

**Checksum de una tabla (idéntico en ambos lados):** sha256 en hexadecimal de la concatenación de una línea por registro vivo, ordenada por `id`. Cada línea es `id + "\t" + json_canónico(data) + "\n"`: claves ordenadas, sin espacios (`separators=(',',':')`), UTF-8 sin escapar, booleanos `true`/`false`.

## Riesgos a cubrir en las pruebas

1. **Eco de la sincronización:** cuando el agente aplica cambios de la nube, no deben entrar a la bandeja de salida (si entran, rebotan para siempre). Lo cubre P1.
2. **Reloj del panel desfasado:** un `updated_at` del panel más de `MAX_CLOCK_SKEW_S` en el futuro no puede ganar siempre. La nube lo ajusta a la hora del servidor y registra el ajuste en el conflicto. Lo cubre N7.
3. **Reintentos y cortes a mitad de la sincronización:** un `POST /changes` repetido con el mismo `change_id` no aplica dos veces. Un pull que falla a mitad de la descarga no aplica nada y se repite desde la misma revisión. Un pull cuyos cambios llegan en un orden que rompe las referencias (una tarjeta antes de su titular) se aplica completo. Lo cubren N7 y P3.
4. **Datos cruzados entre tenants:** un usuario del tenant A o un panel de la instalación A no pueden leer ni escribir datos de B, ni por RLS ni por la API de dispositivos. Lo cubren N2, N3 y N6.
5. **Edición local mientras el agente aplica cambios:** una escritura de la web local en paralelo no se pierde ni se registra como cambio de la nube. Lo cubre P1.

---

## Estructura de archivos

```text
cloud/                                   (en el repositorio access-core)
  package.json  next.config.ts  vitest.config.mts  .env.example  README.md
  supabase/config.toml
  supabase/migrations/0001_org.sql            N2
  supabase/migrations/0002_replicated.sql     N3
  supabase/migrations/0003_panels.sql         N5
  supabase/migrations/0004_sync.sql           N7–N9
  supabase/migrations/0005_notify.sql         N10
  supabase/tests/*.test.sql                   pgTAP
  infra/emqx/docker-compose.yml  infra/emqx/acl.conf  infra/emqx/README.md   N10
  src/lib/supabase/{server,admin,client}.ts   N1
  src/lib/crypto.ts                           N4
  src/lib/device/{auth,contract,projection,checksum,changes,apply,imports}.ts   N5–N9
  src/lib/mqtt/publish.ts                     N10
  src/app/api/device/v1/<ruta>/route.ts       N5–N9
  src/app/api/mqtt/{auth,events}/route.ts     N10
  src/app/api/internal/revision-changed/route.ts   N10
  src/lib/auth/guards.ts                      N5 (requireTenantRole), N11 (completa)
  src/proxy.ts                                N11 (Next 16: antes middleware.ts)
  src/app/(auth)/login/page.tsx  src/app/admin/…  src/app/t/[tenant]/…   N11–N15
  src/app/t/[tenant]/installations/[id]/paneles/actions.ts   N5 (claim/revoke), N8 (confirmImport), N9 (confirmDeletions)
  tests/**/*.test.ts                          Vitest (integración con `supabase start`)

panel/backend/acceso/
  schema.py, migrate.py, constants.py         P1 (v6)
  store/*.py                                  P1 (uuid, updated_at, origin)
  cloud/__init__.py  cloud/__main__.py        P2/P4
  cloud/config.py  cloud/identity.py  cloud/api.py           P2
  cloud/sync.py  cloud/mapping.py  cloud/checksum.py         P3
  cloud/mqtt_link.py  cloud/runner.py                         P4
  web/routes/cloud.py                                         P5
panel/frontend/src/app/(panel)/nube/page.tsx              P5
panel/deploy/acceso-cloud.service, install.sh             P4
```

---

## Parte N — Nube (`cloud/`)

### Tarea N1: Proyecto base

**Archivos:**
- Crear: el proyecto con `npx create-next-app@latest cloud --typescript --app --tailwind --eslint --src-dir --import-alias "@/*" --use-npm --yes`.
- Crear: `supabase init`, `vitest.config.mts`, `.env.example`, `src/lib/supabase/{server,admin,client}.ts`, `src/app/api/health/route.ts` y `README.md`.
- Pruebas: `tests/health.test.ts`.

**Interfaces:**
- Produce:
  - `createServerSupabase()`: cliente con la sesión del usuario (cookies);
  - `createAdminSupabase()`: `service_role`, solo en el servidor; lanza un error si se importa en el navegador;
  - `GET /api/health` → `{ok:true}`.
- `.env.example`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `PIN_ENC_KEY`, `PIN_LOOKUP_KEY`, `EMQX_API_URL`, `EMQX_API_KEY`, `EMQX_API_SECRET`, `EMQX_WEBHOOK_SECRET`, `INTERNAL_WEBHOOK_SECRET` y `APP_URL`.
- **Entorno de pruebas [decisión de Claude]:** las pruebas de integración leen la URL y las llaves de Supabase **local** (de `supabase status`) y no de `.env.local`. Así nunca tocan Access-Core-DEV.

- [ ] **Paso 1:** crear el proyecto dentro del repositorio, **sin** `git init`, porque `cloud/` vive dentro de `access-core`. Agregar `vitest`, `@supabase/ssr` y `@supabase/supabase-js` con versiones fijas, y los scripts `test`, `test:db` (`supabase test db`) y `db:reset`.
- [ ] **Paso 2: prueba.** `test_health`: `GET /api/health` responde `200 {ok:true}`. Ejecutarla y verla fallar.
- [ ] **Paso 3:** implementar. `npm test`, `npm run lint` y `npm run build` pasan sin advertencias. En el README: cómo levantar Supabase local (`supabase start`) y las variables de entorno.
- [ ] **Paso 4:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N2: Organización y RLS

**Archivos:**
- Crear: `supabase/migrations/0001_org.sql`.
- Pruebas: `supabase/tests/org_rls.test.sql` (pgTAP).

**Interfaces — tablas:**
- `tenants(id uuid pk default gen_random_uuid(), name text not null check(length(trim(name))>0), suspended_at timestamptz, created_at timestamptz default now())`
- `platform_admins(user_id uuid pk references auth.users on delete cascade)`
- `tenant_members(tenant_id uuid references tenants on delete cascade, user_id uuid references auth.users on delete cascade, role text not null check(role in ('admin','tecnico')), primary key(tenant_id,user_id))`
- `installations(id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants on delete cascade, name text not null, revision bigint not null default 0, created_at timestamptz default now())`

**Interfaces — funciones `security definer stable`** (en el esquema `private`, según las restricciones globales): `private.is_platform_admin() returns bool`, `private.is_member(t uuid) returns bool` y `private.is_tenant_admin(t uuid) returns bool`. `is_member` e `is_tenant_admin` devuelven `false` si el tenant tiene `suspended_at`.

**Interfaces — RLS:**
- `tenants`: solo lectura para sus miembros; todo para `platform_admin`.
- `tenant_members`: lectura para sus miembros; escritura para `is_tenant_admin` o `platform_admin`.
- `installations`: lectura y escritura para sus miembros.

- [ ] **Paso 1: pruebas pgTAP** (Riesgo 4):
  - un miembro del tenant A ve sus instalaciones y no ve las del tenant B (0 filas);
  - un `tecnico` no puede insertar en `tenant_members` (error 42501);
  - un `admin` sí puede;
  - `platform_admin` ve todos los tenants;
  - un miembro de un tenant suspendido ve 0 instalaciones.

  Ejecutar `supabase test db`: falla.
- [ ] **Paso 2:** implementar la migración. Ejecutar `supabase db reset && supabase test db`: pasa.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N3: Tablas replicadas, revisión y auditoría

**Archivos:**
- Crear: `supabase/migrations/0002_replicated.sql`.
- Pruebas: `supabase/tests/replicated.test.sql`.

**Interfaces — columnas comunes** en `holders`, `cards`, `controls`, `control_buttons`, `access_profiles`, `holder_profiles`, `profile_panel_rules` y `outputs`:
- `id uuid pk default gen_random_uuid()`
- `tenant_id uuid not null`: lo llena un trigger desde la instalación
- `installation_id uuid not null references installations on delete cascade`
- `updated_at timestamptz not null default now()`
- `updated_by text not null`
- `origin text not null` (`'cloud'` o `'panel:<panel_code>'`)
- `deleted_at timestamptz`
- `revision bigint not null`

**Interfaces — columnas propias:**
- `holders`: `kind` (persona/domicilio), `name`, `department`, `address`, `notes`, `pin_ciphertext text`, `pin_lookup text`.
- `cards`: `card_code bigint check 0..4294967295`, `holder_id uuid references holders`, `description`.
- `controls`: `holder_id`, `description`.
- `control_buttons`: `control_id uuid references controls`, `button int 0..3`, `rf_code bigint 0..4294967295`, `output_index int null check 0..3`.
- `access_profiles`: `name`, `local_permission_id int not null check 0..31`.
- `holder_profiles`: `holder_id`, `profile_id`.
- `profile_panel_rules`: `profile_id`, `panel_id uuid` (la FK a `panels` se agrega en N5), `output_mask`, `card_reader_mask`, `pin_reader_mask` (0..15), `allow_rf bool`, `weekday_mask` (0..127), `start_minute` y `end_minute` (0..1439).
- `outputs`: `panel_id` (la FK a `panels` también se agrega en N5), `output_index int 0..3`, `alias text not null default ''`, `duration_ms 0..65535`, `reader_mask 0..15`, `enabled bool`.

**Interfaces — índices únicos parciales (`where deleted_at is null`):**
- `(installation_id, card_code)`
- `(installation_id, rf_code)` en `control_buttons`
- `(installation_id, pin_lookup)`
- `(installation_id, local_permission_id)`
- `(holder_id, profile_id)`
- `(profile_id, panel_id)`
- `(panel_id, output_index)`
- `(control_id, button)`

**Interfaces — triggers:**
- `bump_revision(inst uuid) returns bigint`: hace `update installations set revision=revision+1 … returning revision`.
- Trigger `BEFORE INSERT OR UPDATE` en cada tabla replicada:
  - pone `NEW.revision = bump_revision(NEW.installation_id)` y `NEW.tenant_id` desde la instalación;
  - si `auth.uid()` no es nulo (edición desde la interfaz), pone `updated_at = now()`, `updated_by = 'user:' || auth.uid()` y `origin = 'cloud'`;
  - las escrituras del servidor (`service_role`) traen esos tres valores explícitos.
- Trigger `AFTER UPDATE OF deleted_at` (borrado lógico en cascada, en la misma transacción):
  - un titular borrado borra sus `cards`, `controls` y `holder_profiles`;
  - un control borrado borra sus `control_buttons`;
  - un perfil borrado borra sus `holder_profiles` y `profile_panel_rules`.

  Sin esto, el panel (que borra en cascada de verdad) y la nube quedarían distintos.
- Trigger `AFTER` que inserta en `audit_log(id bigserial, tenant_id, table_name, row_id, op, updated_by, at timestamptz default now())`, sin datos de PIN.

**Interfaces — RLS:** todas las tablas, por `is_member(tenant_id)`.

- [ ] **Paso 1: pruebas pgTAP:**
  - dos escrituras seguidas aumentan `installations.revision` en 1 cada una y la fila guarda esa revisión;
  - insertar dos tarjetas vivas con el mismo `card_code` en la misma instalación falla; si la primera tiene `deleted_at`, se permite;
  - el mismo `card_code` en otra instalación se permite;
  - RLS entre tenants da 0 filas (Riesgo 4);
  - `audit_log` no tiene columna con PIN;
  - borrar lógicamente un titular con 2 tarjetas y 1 control con 2 botones deja las 5 filas con `deleted_at`, cada una con su propia revisión;
  - una edición como usuario autenticado deja `origin='cloud'` y `updated_by='user:<uid>'`.

  Ejecutarlas: fallan.
- [ ] **Paso 2:** implementar. `supabase test db` pasa.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N4: Criptografía y códigos

**Archivos:**
- Crear: `src/lib/crypto.ts`.
- Pruebas: `tests/crypto.test.ts`.

**Interfaces:**
- `encryptPin(pin: string): string`
- `decryptPin(blob: string): string`
- `pinLookup(installationId: string, pin: string): string`
- `sha256Hex(s: string): string`
- `randomBase32(n: number): string` (alfabeto Crockford de las restricciones globales)
- `newDeviceToken(): string` (base64url de 32 bytes)

- [ ] **Paso 1: pruebas:**
  - `decryptPin(encryptPin("0123")) === "0123"`;
  - dos cifrados del mismo PIN difieren (IV aleatorio);
  - alterar un byte → `decryptPin` lanza error;
  - `pinLookup` es estable y difiere entre instalaciones;
  - `randomBase32(8)` tiene 8 caracteres del alfabeto (sin `I`, `L`, `O` ni `U`).
- [ ] **Paso 2:** implementar con Node `crypto`, con las claves de `PIN_ENC_KEY` y `PIN_LOOKUP_KEY` (base64, 32 bytes; lanzar error si faltan). Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N5: Paneles, registro, vinculación y activación

**Archivos:**
- Crear: `supabase/migrations/0003_panels.sql`, `src/lib/device/auth.ts`, `src/lib/auth/guards.ts` (con `requireTenantRole`, que N11 completa), `src/app/api/device/v1/{register,activate,link-state}/route.ts` y `src/app/t/[tenant]/installations/[id]/paneles/actions.ts`.
- La migración agrega también las FK de `profile_panel_rules.panel_id` y `outputs.panel_id` hacia `panels`.
- Pruebas: `tests/device/linking.test.ts` y `supabase/tests/panels.test.sql`.

**Interfaces — tabla `panels`:**
- `id uuid pk`, `panel_code text unique not null`;
- `claim_code_hash text`, `panel_secret_hash text not null`, `device_token_hash text`;
- `installation_id uuid null references installations`, `tenant_id uuid null`;
- `status text check in ('pending','claimed','staging','awaiting_review','active','revoked')`;
- `online bool default false`, `last_seen_at timestamptz`, `software_version text`, `schema_version int`;
- `synced_revision bigint default 0`, `last_sync_at timestamptz`, `sync_blocked jsonb`, `confirm_deletions_until timestamptz`, `created_at`.

RLS: los miembros leen los paneles de su tenant. Las escrituras solo van por servidor (`service_role`).

**Interfaces — funciones:**
- `authenticateDevice(req: Request): Promise<Panel>`: valida `Authorization: Device <code>.<token>` contra `device_token_hash` y el estado (`staging`, `awaiting_review` o `active`). Si no es válido responde `401 {code:"unauthorized"}`. Actualiza `last_seen_at`.
- Server action `claimPanel(installationId, panelCode, claimCode)`:
  - solo para `admin`;
  - compara `sha256(claimCode)` con `claim_code_hash`;
  - si coinciden: `status='claimed'`, se asignan instalación y tenant y se borra `claim_code_hash`;
  - se permiten como máximo **10 intentos fallidos por tenant por hora**; después responde 429 `"Demasiados intentos; espera una hora."`.
- Server action `revokePanel(panelId)`: `status='revoked'` y `device_token_hash=null`.

**Interfaces — flujo:** `/activate` con `status='claimed'` y el `panel_secret` correcto:
1. genera un token y guarda su hash;
2. `status='staging'`;
3. devuelve el token **una sola vez**. Si se llama otra vez estando en `staging` o más adelante, responde `409`.

- [ ] **Paso 1: pruebas de integración** (Supabase local; los handlers se invocan con `Request`):
  - `register` → `pending`;
  - `claimPanel` con un código erróneo falla; con el correcto deja el panel `claimed`;
  - `activate` sin reclamar → `202`; reclamado → `200` con token; una segunda llamada → `409`;
  - token válido en `link-state` → `staging`; token de otro panel → `401`;
  - `register` del mismo `panel_code` con otro `panel_secret_hash` → `409`;
  - el intento 11 en una hora → `429`;
  - después de `revokePanel`, el token da `401` y un `register` con el mismo secreto y un código nuevo deja el panel `pending`, sin instalación, y reclamable con el código nuevo.
- [ ] **Paso 2:** implementar. `npm test` pasa.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N6: Proyección por panel y `GET /changes`, `/checksums` y `/snapshot`

**Archivos:**
- Crear: `src/lib/device/{contract,projection,checksum}.ts` y `src/app/api/device/v1/{changes,checksums,snapshot}/route.ts` (solo GET).
- Pruebas: `tests/device/pull.test.ts` y `tests/device/checksum.test.ts`.

**Interfaces:**
- `contract.ts`: tipos TypeScript del contrato (`ChangeItem`, `PullResponse`, `PushItem`, `PushResult`, `TableName`) y validación con `zod` de la forma de `data` de cada tabla.
- `projectPermission(profile, ruleForPanel | null): PermissionData`: sin regla → todas las máscaras en 0 y `allow_rf=false`, con el `name` y `local_permission_id` del perfil.
- `listChanges(panel, since: number, limit: number): Promise<PullResponse>`, que lee:
  - de la instalación: registros con `revision > since` (incluye borrados como `op:"delete"`);
  - `outputs` y `profile_panel_rules` de **ese** panel;
  - un cambio de perfil o de su regla para ese panel emite `permissions`;
  - `holder_profiles` → `holder_permissions` con `permission_id = local_permission_id`;
  - el PIN se descifra para `holders.data.pin`;
  - responde `has_more` si hay más de `limit`, y `confirm_deletions` según el contrato;
  - si `since >= installations.revision`, responde `changes:[]` sin consultar las tablas replicadas;
  - en cada llamada guarda `panels.synced_revision = since` y `last_sync_at = now()`.
- `tableChecksum(rows: {id: string, data: object}[]): string`, con el algoritmo del contrato.

- [ ] **Paso 1: pruebas:**
  - una instalación con dos paneles, con el perfil "Residente": regla en A (`card 15`, `allow_rf true`) y sin regla en B → el pull de A trae `permissions{permission_id:0, card_reader_mask:15, allow_rf:true}` y el de B trae máscaras en 0;
  - una tarjeta borrada aparece como `op:"delete"`;
  - un pull con `since` = revisión actual devuelve `changes:[]`;
  - el panel A no recibe `outputs` del panel B;
  - un panel de otra instalación recibe solo sus datos (Riesgo 4);
  - checksum de `[{id:"b",data:{x:1}},{id:"a",data:{y:true,a:"ñ"}}]` = sha256 de `a\t{"a":"ñ","y":true}\nb\t{"x":1}\n` (vector fijo, copiado en la prueba de Python P3).
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N7: `POST /changes` (cambios hechos en el panel)

**Archivos:**
- Crear: `src/lib/device/apply.ts`, el método POST en `src/app/api/device/v1/changes/route.ts` y `supabase/migrations/0004_sync.sql` (con `sync_conflicts` y `device_changes`).
- Pruebas: `tests/device/push.test.ts`.

**Interfaces — tablas:**
- `device_changes(panel_id uuid, change_id text, result jsonb, created_at, primary key(panel_id, change_id))`. `result` guarda solo `{status, revision, reason}`; `current` se vuelve a calcular al repetir, para no guardar PIN.
- `sync_conflicts(id bigserial, tenant_id, installation_id, panel_id, table_name, row_id, kind text check in ('lww','unique','skew'), cloud_version jsonb, panel_version jsonb, resolution text, created_at)`. Las versiones guardadas nunca incluyen PIN.

**Interfaces — `applyPanelChanges(panel, items: PushItem[]): Promise<PushResponse>`:**
- **Idempotencia:** un `change_id` ya visto devuelve el mismo resultado guardado.
- **Desfase de reloj:** si `updated_at` está más de `MAX_CLOCK_SKEW_S` en el futuro, se usa `now()` y se registra un conflicto `skew`.
- **Último en escribir (LWW):** si existe un registro vivo con `updated_at` más nuevo, el resultado es `superseded` y se registra un conflicto `lww`. En empate gana la nube.
- **Unicidad:** si el código de tarjeta, el código RF o el PIN chocan con otro titular, el resultado es `rejected` con razón `"duplicado"` y se registra un conflicto `unique`.
- **Traducción a las tablas de la nube:**
  - `permissions` → actualiza `access_profiles.name` y la `profile_panel_rules` de ese panel;
  - un `permission_id` sin perfil crea un perfil con ese `local_permission_id`; si ya lo usa otro perfil, el resultado es `rejected`;
  - `delete` de `permissions` → borra el **perfil** en toda la instalación, con su cascada (N3). Así funciona igual que el borrado local, que también quita el permiso a los titulares;
  - `holder_permissions` → `holder_profiles`;
  - `outputs` → las salidas de ese panel;
  - `delete` → `deleted_at = now()`.
- **Registro:** `updated_by` y `origin` = `'panel:<panel_code>'`. El PIN se cifra y se calcula `pin_lookup`.
- **`current`:** acompaña a todo `superseded` o `rejected`, en la forma del contrato para ese panel, para que el panel quede igual a la nube sin esperar al siguiente pull.

- [ ] **Paso 1: pruebas:**
  - un alta de tarjeta → `applied` y la revisión sube;
  - repetir el mismo `change_id` → mismo resultado sin efecto doble (Riesgo 3);
  - un `updated_at` del panel anterior al de la nube → `superseded`, con un conflicto `lww` y `current` con la versión de la nube;
  - un titular nuevo cuyo PIN ya tiene otro titular → `rejected` con `current: null`, y ni el conflicto ni `device_changes` guardan el PIN;
  - un `delete` de `permissions` deja el perfil, sus `holder_profiles` y sus reglas en todos los paneles con `deleted_at`;
  - un `updated_at` 1 hora en el futuro → se guarda con `now()` y queda un conflicto `skew` (Riesgo 2);
  - un `card_code` duplicado con otro titular → `rejected`;
  - `permissions` con `permission_id` 3 nuevo crea el perfil y la regla solo para ese panel;
  - un panel no puede modificar un registro de otra instalación: `rejected` con `"no encontrado"` (Riesgo 4).
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N8: Importación al vincular

**Archivos:**
- Crear: `src/lib/device/imports.ts`, `src/app/api/device/v1/import-snapshot/route.ts` y en `0004_sync.sql` la tabla `panel_imports(panel_id pk, snapshot jsonb, diff jsonb, created_at)`.
- Pruebas: `tests/device/import.test.ts`.

**Interfaces:**
- `stageSnapshot(panel, tables)`:
  - si la instalación **no tiene datos vivos**, importa todo como cambios del panel (con los UUID del panel) y deja `status='active'`;
  - si tiene datos, calcula el `diff` y deja `status='awaiting_review'`.
- `computeImportDiff(cloud, snapshot): ImportDiff`, con las listas `onlyInPanel` (titulares con sus tarjetas, controles y PIN que la nube no tiene) y `conflicts`. Criterios de coincidencia:
  - tarjeta por `card_code`;
  - botón por `rf_code`;
  - PIN por `pin_lookup`;
  - titular por `kind` + `name` sin distinguir mayúsculas.
- Server action `confirmImport(panelId, selectedIds: string[])`, en `src/app/t/[tenant]/installations/[id]/paneles/actions.ts`:
  - importa solo lo seleccionado, como alta pura: un titular con el mismo `kind` y `name` se reutiliza;
  - los conflictos nunca se importan;
  - los permisos locales del panel se vuelven perfiles nuevos con regla solo en ese panel. Toman el menor `local_permission_id` libre, y se asignan a los titulares seleccionados que los tenían. Pasando de 32 perfiles, los sobrantes van a `conflicts` con `"Máximo 32 perfiles por instalación."`;
  - las salidas del panel siempre se importan;
  - termina con `status='active'`.

- [ ] **Paso 1: pruebas:**
  - una instalación vacía con un snapshot de 2 titulares y 3 tarjetas → `active`, y se encuentran por los mismos UUID;
  - una instalación con datos y un snapshot con una tarjeta nueva y una tarjeta cuyo `card_code` ya es de otro titular → `awaiting_review`, con 1 en `onlyInPanel` y 1 en `conflicts`;
  - `confirmImport` importa la nueva y no la conflictiva;
  - un titular con el mismo nombre se reutiliza en lugar de duplicarse.
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N9: Logs, retención y alertas

**Archivos:**
- Crear: `src/app/api/device/v1/{logs,alerts}/route.ts` y en `0004_sync.sql` la tabla `access_logs` y la tarea `pg_cron`.
- Pruebas: `tests/device/logs.test.ts`.

**Interfaces — tabla `access_logs`:**
- `id bigserial`, `tenant_id`, `installation_id`, `panel_id`, `local_log_id bigint`;
- `ts timestamptz`, `allowed bool`, `source int`, `reason int`;
- `holder_id uuid null`, `holder_name`, `holder_kind`, `credential_label`, `control_id uuid null`;
- `code bigint null`, `device_id int null`, `output_index int null`;
- `unique(panel_id, local_log_id)`;
- índices por `(installation_id, ts desc)` y `(panel_id, ts desc)`.

**Interfaces — comportamiento:**
- **`POST /logs`:** inserta con `on conflict do nothing` y devuelve `last_local_log_id` como el mayor recibido.
- **Retención:** `pg_cron` corre el día 1 de cada mes y borra lo que tenga más de 12 meses.
- **`POST /alerts`:**
  - guarda `panels.sync_blocked = {type, table, would_delete, total, at}`;
  - la server action `confirmDeletions(panelId)` (solo `admin`, en `paneles/actions.ts`) pone `confirm_deletions_until = now() + CONFIRM_DELETIONS_WINDOW_S` y limpia `sync_blocked`;
  - la confirmación caduca sola: no hay que reiniciarla.

- [ ] **Paso 1: pruebas:**
  - enviar dos veces el mismo lote → una sola fila por `local_log_id`;
  - un log con `code=null` y fuente 3 (PIN) se acepta;
  - la alerta deja `sync_blocked`;
  - después de `confirmDeletions`, el pull y `/checksums` traen `confirm_deletions:true`; con `confirm_deletions_until` en el pasado, `false`.
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N10: MQTT (EMQX), avisos de cambio y estado en línea

**Archivos:**
- Crear: `infra/emqx/docker-compose.yml`, `infra/emqx/acl.conf`, `src/lib/mqtt/publish.ts`, `src/app/api/mqtt/{auth,events}/route.ts`, `src/app/api/internal/revision-changed/route.ts` y `supabase/migrations/0005_notify.sql`.
- Pruebas: `tests/mqtt.test.ts`.

**Interfaces — EMQX 5:**
- **Listeners:** `ssl:8883` y `wss:443`.
- **Autenticación:** HTTP, `POST ${APP_URL}/api/mqtt/auth` con `{username, password}`. Responde `{"result":"allow"}` si `username` es un `panel_code` activo, en `staging` o en `awaiting_review` con su token; si no, `{"result":"deny"}`.
- **Autorización por archivo (`acl.conf`):** suscribirse solo a `acc/${username}/cmd`; publicar solo en `acc/${username}/evt` y `acc/${username}/status`; todo lo demás se niega.
- **Regla:** `SELECT * FROM "$events/client_connected", "$events/client_disconnected"` → webhook `POST ${APP_URL}/api/mqtt/events` con el encabezado `x-emqx-secret`.

**Interfaces — `publishToPanel(panelCode, payload)`:** usa `POST ${EMQX_API_URL}/api/v5/publish` con QoS 1 y autenticación básica (API key y secret).

**Interfaces — receptores:**
- **`/api/mqtt/events`:** valida el secreto y, en `client_connected` o `client_disconnected`, actualiza `online` y `last_seen_at`.
- **Aviso de revisión:** en `0005_notify.sql`, un `CONSTRAINT TRIGGER … AFTER UPDATE OF revision ON installations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` llama con `pg_net` a `net.http_post(APP_URL || '/api/internal/revision-changed', body {installation_id, revision}, header x-internal-secret)`.
  - Se envía **un solo aviso por instalación por transacción**: la marca `set_config('acc.notified.' || id, '1', true)` evita repetirlo. Así, importar 450 filas no manda 450 avisos.
  - `APP_URL` y el secreto se guardan en Supabase Vault.
  - **[decisión de Claude]** Si Vault no tiene `APP_URL` o el secreto (por ejemplo, en las pruebas de integración de otras tareas), el trigger no hace nada y no falla.
- **`/api/internal/revision-changed`:** valida el secreto y publica `{"type":"sync","revision":N}` a cada panel `active` de la instalación.

- [ ] **Paso 1: pruebas** (sin broker; `fetch` simulado):
  - `/api/mqtt/auth` con token correcto → allow; incorrecto o panel revocado → deny;
  - `/api/mqtt/events` sin secreto → `401`; con secreto, conectado → `online=true`;
  - `/api/internal/revision-changed` publica una vez por panel activo y ninguna para los revocados;
  - en pgTAP: una transacción que escribe 3 filas de la misma instalación, con `SET CONSTRAINTS ALL IMMEDIATE`, deja 1 sola petición en `net.http_request_queue`.
- [ ] **Paso 2:** implementar. Verificar el `docker-compose` con `docker compose -f infra/emqx/docker-compose.yml config`. El README de `infra/emqx` explica TLS (certificados con Caddy o certbot) y cómo crear la API key.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N11: Acceso, súper administrador y usuarios del tenant

**Archivos:**
- Crear: `src/app/(auth)/login/page.tsx`, `src/app/admin/tenants/page.tsx`, `src/app/t/[tenant]/users/page.tsx` y `src/proxy.ts` (Next 16 renombró `middleware.ts` a `proxy.ts`).
- Completar: `src/lib/auth/guards.ts`, que N5 creó.
- **[decisión de Claude]** El proxy no toca `/api/*`: las rutas de dispositivo, MQTT, internas y de salud tienen su propia autenticación.
- Pruebas: `tests/ui/guards.test.ts` y `tests/ui/tenants.test.tsx`.

**Interfaces:**
- **Inicio de sesión:** Supabase Auth con correo y contraseña. El proxy lleva a `/login` a quien no tenga sesión.
- **Guardas:** `requirePlatformAdmin()` y `requireTenantRole(tenantId, 'admin'|'tecnico')` responden 403 si no se cumplen.
- **`/admin/tenants`:** lista, alta y suspensión de tenants, e invitación del primer `admin` con `auth.admin.inviteUserByEmail`.
- **`/t/[tenant]/users`:** solo para `admin`; lista, invita, cambia rol y quita miembros. No permite quitar al último `admin`.
- **Aspecto:** interfaz en español, con el mismo lenguaje visual del panel local (`panel/frontend/src/app/globals.css`). Al implementar, usar las skills `frontend-design` y `vercel-react-best-practices`.

- [ ] **Paso 1: pruebas:**
  - un `tecnico` que abre `/t/X/users` → 403;
  - un no-administrador de plataforma en `/admin/tenants` → 403;
  - quitar al último `admin` → error `"El tenant debe tener al menos un administrador."`.
- [ ] **Paso 2:** implementar. `npm test`, `lint` y `build` pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N12: Instalaciones y paneles en la interfaz

**Archivos:**
- Crear: `src/app/t/[tenant]/installations/page.tsx`, `src/app/t/[tenant]/installations/[id]/layout.tsx` y `src/app/t/[tenant]/installations/[id]/paneles/page.tsx`.
- Pruebas: `tests/ui/panels.test.tsx`.

**Interfaces:**
- **Instalaciones:** lista con alta y cambio de nombre.
- **Pestañas de la instalación:** Paneles, Titulares, Tarjetas, Controles, Perfiles, Salidas, Logs y Conflictos.
- **Pestaña Paneles:**
  - formulario "Vincular panel" (`panel_code` + código), que llama `claimPanel`;
  - tabla: código, estado, En línea / Fuera de línea, última sincronización, revisión del panel contra la de la instalación y versión;
  - acciones: "Revocar" (con confirmación);
  - avisos: "Revisar importación" si está en `awaiting_review` (pantalla de N8: lista `onlyInPanel` con casillas y `conflicts` en solo lectura, más el botón "Importar seleccionados"), y "Confirmar borrados" si tiene `sync_blocked`.

- [ ] **Paso 1: pruebas:**
  - la tabla muestra "Fuera de línea" cuando `online=false`;
  - la revisión atrasada se marca;
  - la pantalla de importación envía solo los IDs marcados.
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N13: Titulares, tarjetas y controles en la interfaz

**Archivos:**
- Crear: `src/app/t/[tenant]/installations/[id]/{titulares,tarjetas,controles}/page.tsx` y `actions.ts`.
- Adaptar: los componentes `HolderForm`, `CardForm`, `ControlForm` y `useApiList` de `panel/frontend/src/components` y `src/lib`.
- Pruebas: `tests/ui/holders.test.tsx` y `tests/ui/controls.test.tsx`.

**Interfaces:**
- **Escrituras:** con server actions que usan el cliente con sesión (RLS). El PIN se cifra en el servidor (`encryptPin` y `pinLookup`).
- **Listas:** muestran `has_pin`. El PIN solo se ve al editar y solo para `admin`.
- **Errores:** usan los mismos textos que el panel local (`"La tarjeta N ya está registrada a <titular>."`, etc.).
- **Borrados:** son lógicos (`deleted_at`).

- [ ] **Paso 1: pruebas:**
  - un `tecnico` editando un titular no recibe el PIN;
  - un `card_code` duplicado muestra el mensaje en español;
  - borrar una tarjeta deja `deleted_at` y aumenta la revisión.
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N14: Perfiles y salidas en la interfaz

**Archivos:**
- Crear: `src/app/t/[tenant]/installations/[id]/{perfiles,salidas}/page.tsx` y `actions.ts`.
- Pruebas: `tests/ui/profiles.test.tsx`.

**Interfaces:**
- **Perfiles:**
  - alta, nombre y borrado; `local_permission_id` toma el menor libre (0 a 31);
  - un perfil número 33 → error `"Máximo 32 perfiles por instalación."`;
  - asignación a titulares;
  - **editor de reglas por panel**: una columna por panel, con salidas por alias (S1 a S4 con su alias como texto emergente), cuadrícula de lectores × {Tarjeta, PIN}, "Permitir control RF", días y horario; "Sin acceso en este panel" elimina la regla.
- **Salidas:** las 4 salidas por panel, con alias, duración, lectores y si está habilitada.

- [ ] **Paso 1: pruebas:**
  - guardar una regla solo para el panel A → `profile_panel_rules` tiene 1 fila;
  - el perfil número 33 se rechaza con el mensaje;
  - cambiar el alias aumenta la revisión.
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea N15: Logs y conflictos en la interfaz

**Archivos:**
- Crear: `src/app/t/[tenant]/installations/[id]/{logs,conflictos}/page.tsx`.
- Pruebas: `tests/ui/logs.test.tsx`.

**Interfaces:**
- **Logs:** filtros por fecha, panel, titular, resultado y origen. Columnas: Fecha, Panel, Resultado, Titular, Medio, Código, Salida (alias) y Motivo. Reutiliza las etiquetas de `panel/frontend/src/lib/format.ts`. Paginación de 50.
- **Conflictos:** lista de `sync_conflicts` (tipo, tabla, panel, fecha y resolución) y el botón "Marcar como revisado".

- [ ] **Paso 1: pruebas:**
  - el filtro "Origen = PIN" pide `source=3`;
  - la salida se muestra con su alias;
  - un conflicto de unicidad muestra `"Rechazado: duplicado"`.
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

## Parte P — Panel (`panel/`)

### Tarea P1: Esquema v6 (UUID, marcas de cambio y bandeja de salida)

**Archivos:**
- Modificar: `backend/acceso/{constants,schema,migrate}.py` y `backend/acceso/store/{holders,cards,controls,permissions,outputs}.py`.
- Modificar la web local: alias de salidas en `web/schemas.py`, `web/routes/outputs.py`, `frontend/src/components/OutputForm.tsx` y la página `salidas`.
- Pruebas: `tests/test_migrate.py`, `tests/test_schema_v6.py`, `tests/test_outbox.py` y las del frontend de salidas.

**Interfaces:**
- **Esquema:** `SCHEMA_VERSION = 6`.
- **Columnas nuevas** en `holders`, `cards`, `controls`, `control_buttons`, `permissions`, `holder_permissions` y `outputs`:
  - `uuid TEXT NOT NULL UNIQUE`;
  - `updated_at INTEGER NOT NULL` (ms desde la época);
  - `origin TEXT NOT NULL DEFAULT 'local'`.
- **`outputs`:** agrega `alias TEXT NOT NULL DEFAULT ''`.
- **Tablas nuevas:**
  - `sync_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL UNIQUE, table_name TEXT NOT NULL, op TEXT NOT NULL CHECK(op IN ('upsert','delete')), row_uuid TEXT NOT NULL, updated_at INTEGER NOT NULL)`;
  - `sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  - `sync_guard(id INTEGER PRIMARY KEY CHECK(id=1), applying INTEGER NOT NULL DEFAULT 0)`, con su única fila.
- **Triggers** `AFTER INSERT`, `AFTER UPDATE` y `AFTER DELETE` en cada tabla replicada, con `WHEN (SELECT applying FROM sync_guard WHERE id=1)=0`. También se disparan con los borrados en cascada de las llaves foráneas. Insertan en `sync_outbox`:
  - `change_id` = `lower(hex(randomblob(16)))` (32 caracteres hexadecimales);
  - `upsert` con `NEW.uuid` o `delete` con `OLD.uuid`;
  - `updated_at` = `NEW.updated_at` en altas y cambios, y la hora actual en ms (`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`) en borrados.

  El payload no se guarda: el agente lee la fila al enviar.
- **Migración v5→v6:** sigue las garantías de `migrate.py` (bloqueo, una transacción, respaldo `_backup_v5` en 0600, máximo 3 copias fechadas). Genera `uuid4` y `updated_at` para todas las filas existentes, y **no** genera entradas en la bandeja.
- **Capa `store`:** cada alta pone `uuid=str(uuid4())`, y cada alta o edición pone `updated_at=now_ms()` y `origin='local'`.
  - `store/holders.py` hoy borra y vuelve a crear todos los `holder_permissions` del titular al guardar. Pasa a hacerlo **por diferencia**: inserta las asignaciones nuevas y borra las quitadas. Así no cambian los UUID ni se llena la bandeja.
- **README:** nota de actualización a v6. Para volver atrás, restaurar `<db>_backup_v5.sqlite` con los servicios detenidos y borrar `-wal` y `-shm`.

- [ ] **Paso 1: pruebas:**
  - una base v5 con datos se migra a v6 conservando todas las filas, cada fila con un UUID único y la bandeja vacía;
  - el esquema de una v6 nueva es igual al migrado;
  - editar una tarjeta con la web local agrega 1 entrada `upsert` con su UUID;
  - borrarla agrega `delete` con el UUID anterior;
  - borrar un titular con 2 tarjetas agrega 3 entradas `delete` (las tarjetas por la cascada);
  - guardar un titular sin cambiar sus permisos agrega solo 1 entrada (la del titular) y conserva los UUID de sus `holder_permissions`;
  - con `sync_guard.applying=1` dentro de una transacción, un cambio no genera entradas, y tras reponerlo a 0 y confirmar, el siguiente cambio sí (Riesgo 1);
  - una escritura de la web en paralelo, en otro hilo, durante la aplicación del agente espera (`busy_timeout`) y sí genera su entrada (Riesgo 5);
  - la salida 1 con alias "Pluma vehicular" se guarda y la página de salidas lo muestra.
- [ ] **Paso 2:** implementar. Correr toda la suite del backend y `npm test`, `lint` y `build` en el frontend: todo pasa.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea P2: Agente: configuración, identidad, registro y activación

**Archivos:**
- Crear: `backend/acceso/cloud/{__init__,config,identity,api}.py`.
- Modificar: `backend/pyproject.toml` (dependencias `httpx` y `paho-mqtt>=2`) y `backend/constraints.txt` (versiones fijas de `httpx`, `paho-mqtt` y sus dependencias, probadas en Python 3.9).
- Pruebas: `tests/cloud/test_identity.py` y `tests/cloud/test_activation.py`.

**Interfaces:**
- **`config.CloudSettings`:** con `cloud_url` (variable `CLOUD_URL`), `mqtt_url` (variable `MQTT_URL`) y `credentials_path` (por defecto `/etc/acceso/cloud.env`). `load_cloud_settings(env=None)` sigue el estilo de `acceso.config.load_settings`.
- **Llaves de `sync_state`** (las lee también P5): `panel_code`, `claim_code`, `panel_secret`, `state` (`unlinked` | `staging` | `awaiting_review` | `active`), `installation_name`, `cloud_revision`, `last_log_uploaded`, `last_sync_at` y `last_error`.
- **`identity.ensure_identity(conn) -> Identity(panel_code, claim_code, panel_secret)`:** si `sync_state` no los tiene, los genera según las restricciones globales y los guarda ahí. `regenerate_claim_code(conn) -> str` cambia solo el código de vinculación.
- **`api.CloudApi(base_url, transport=None)`:**
  - `register(identity, versions)`;
  - `activate(panel_code, panel_secret) -> Optional[Activation(device_token, installation_id, installation_name)]` (`None` si responde 202);
  - `link_state()`, `import_snapshot(tables)`, `get_changes(since, limit)`, `post_changes(items)`, `post_logs(logs)`, `get_checksums()`, `get_snapshot(table)` y `post_alert(alert)`.
- **Sesión del dispositivo:** se configura con `authenticate(panel_code, token)`. Los errores HTTP lanzan `CloudError(status, code)`.
- **`save_credentials(path, panel_code, token)`:** escribe `CLOUD_PANEL_CODE` y `CLOUD_DEVICE_TOKEN` en el archivo y conserva las demás líneas (`CLOUD_URL`, `MQTT_URL`).
  - Lo reescribe en el mismo archivo, con `fsync`, porque el usuario `acceso` no puede crear archivos en `/etc/acceso`. El modo queda en 0600.
  - `load_credentials(path) -> Optional[tuple[str, str]]` las lee, y `clear_credentials(path)` las quita.

- [ ] **Paso 1: pruebas** (con `httpx.MockTransport`):
  - `ensure_identity` es estable en una segunda llamada y el formato del código es `^PNL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`;
  - `register` envía `sha256` y nunca el código en claro;
  - `activate` con 202 → `None`; con 200 → `Activation`, y las credenciales guardadas tienen modo 0600;
  - un `401` en `get_changes` lanza `CloudError(401, "unauthorized")`.
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea P3: Motor de sincronización

**Archivos:**
- Crear: `backend/acceso/cloud/{mapping,sync,checksum}.py`.
- Pruebas: `tests/cloud/test_sync.py` y `tests/cloud/test_checksum.py`.

**Interfaces:**
- **`mapping`:**
  - `row_to_data(conn, table, uuid) -> dict`: forma del contrato, con referencias por UUID y el PIN en claro;
  - `apply_upsert(conn, table, uuid, data)` y `apply_delete(conn, table, uuid)`: borrado **real**; traducen UUID ↔ ID entero local y asignan IDs locales nuevos donde haga falta;
  - `snapshot_tables(conn) -> dict`.
- **`checksum.table_checksum(rows) -> str`:** mismo algoritmo y mismo vector de prueba que N6.
- **Cómo se aplican los cambios de la nube** (`mapping.apply_batch(conn, changes)`, usado por `pull`, por `current` y por `reconcile`):
  - todo va en una sola transacción `BEGIN IMMEDIATE`, con `PRAGMA defer_foreign_keys=ON` y `sync_guard.applying=1`, que se regresa a 0 antes del `COMMIT`;
  - primero los borrados, de hijos a padres: `control_buttons`, `cards`, `holder_permissions`, `controls`, `holders`, `permissions`;
  - después las altas y cambios, de padres a hijos: `holders`, `permissions`, `outputs`, `controls`, `cards`, `control_buttons`, `holder_permissions`;
  - borrar un UUID que no existe no hace nada;
  - si una llave única (`card_code`, `rf_code`, `pin`, `permission_id`) la tiene otra fila local con otro UUID, esa fila se borra antes. La nube es la referencia; si esa fila sigue viva, llega en el mismo lote.
- **`SyncEngine(db_path, api, *, now=time.time)`** (abre conexiones con `acceso.db.connect`):
  - **`push() -> int`:**
    - envía la bandeja en lotes de `CHANGES_PAGE`, en orden de `seq`;
    - junta las entradas de un mismo `row_uuid` en la última y omite un `upsert` cuya fila ya no existe;
    - borra del outbox las entradas con resultado;
    - con `current`, aplica esa versión con `apply_batch` (`null` = borrar) y guarda la razón en `last_error`.
  - **`pull() -> int`:**
    1. descarga **todas** las páginas de `get_changes(since=sync_state.cloud_revision)`, sin aplicar nada;
    2. revisa la protección contra borrados masivos;
    3. aplica todo con `apply_batch` y guarda `cloud_revision` y `last_sync_at` en la misma transacción.

    Si la descarga falla a mitad, no se aplica nada y el siguiente intento empieza desde el mismo `since`.
  - **Protección contra borrados masivos:** antes de aplicar, si los `delete` de `holders` o de `cards` son al menos `MASS_DELETE_MIN` y superan `MASS_DELETE_RATIO` de las filas vivas de esa tabla, y `confirm_deletions` es falso, entonces no aplica nada, envía `post_alert` y lanza `SyncBlocked`.
  - **`upload_logs() -> int`:** sube desde `sync_state.last_log_uploaded` en lotes de `LOG_BATCH`, traduce `holder_id` y `control_id` a UUID (o `null`), y nunca incluye dígitos de PIN.
  - **`reconcile() -> list[str]`:** compara checksums por tabla y reemplaza las tablas distintas con `get_snapshot` (los registros que sobran localmente se borran), con la misma protección contra borrados masivos.
  - **`adopt_cloud() -> None`:**
    1. toma `R0 = get_checksums().revision`;
    2. respalda la base local (sqlite backup, 0600);
    3. reemplaza las tablas replicadas, salvo `outputs`, con snapshots de la nube;
    4. vacía `sync_outbox` (los cambios locales hechos mientras se revisaba la importación se descartan);
    5. guarda `cloud_revision = R0`, para que el siguiente pull traiga lo que cambió durante la adopción.

- [ ] **Paso 1: pruebas** (con nube falsa en `MockTransport`, que guarda revisiones):
  - un alta de tarjeta en la web local → `push` la envía con `change_id` y la bandeja queda vacía;
  - un pull con una tarjeta nueva la inserta y **no** crea entrada en la bandeja (Riesgo 1);
  - un pull cuya página 2 falla no aplica la página 1, deja `cloud_revision` igual, y el reintento aplica todo (Riesgo 3);
  - un pull donde la tarjeta (revisión 10) llega antes que el alta de su titular (revisión 12) se aplica sin error de llave foránea (Riesgo 3);
  - un pull que borra la tarjeta X (código 5) y da de alta la tarjeta Y con el mismo código 5 queda con Y;
  - un pull que borraría 30 de 100 tarjetas sin `confirm_deletions` no aplica nada y envía la alerta; con `confirm_deletions` sí aplica; borrar 3 de 5 tarjetas nunca se bloquea (menos de `MASS_DELETE_MIN`);
  - tres ediciones locales de la misma tarjeta se envían como 1 cambio;
  - un `rejected` con `current: null` borra la fila local sin crear entradas en la bandeja, y un `superseded` con `current` deja la versión de la nube;
  - `adopt_cloud` deja un respaldo en modo 0600, conserva las `outputs` locales, vacía la bandeja y guarda `cloud_revision = R0`;
  - `upload_logs` con un log de PIN (fuente 3) envía `code=null` y el `holder_id` como UUID;
  - un checksum distinto en `cards` → `reconcile` reemplaza solo `cards`;
  - el vector de checksum es idéntico al de N6;
  - un permiso que llega con máscaras en 0 se aplica, y el daemon niega la tarjeta en ese lector (prueba con `handle_event`).
- [ ] **Paso 2:** implementar. Las pruebas pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea P4: Agente: MQTT, planificador y servicio

**Archivos:**
- Crear: `backend/acceso/cloud/{mqtt_link,runner,__main__}.py` y `deploy/acceso-cloud.service`.
- Modificar:
  - `deploy/install.sh`: instala y habilita la unidad. Si `/etc/acceso/cloud.env` no existe, lo crea con `CLOUD_URL` y `MQTT_URL`, dueño `acceso:acceso` y modo 0600; si ya existe, no lo toca;
  - `deploy/env.example`.
- Pruebas: `tests/cloud/test_runner.py`.

**Interfaces:**
- **`MqttLink(settings, panel_code, token, on_sync: Callable[[int], None], client_factory=paho.Client)`:**
  - usa TLS;
  - LWT retenido `offline` en `acc/<code>/status` y, al conectar, publica `online` retenido;
  - se suscribe a `acc/<code>/cmd`;
  - un mensaje `{"type":"sync"}` llama `on_sync`;
  - reintenta la conexión cada 10 s.
- **`Runner(settings, db_path, api, engine_factory, mqtt_factory, clock, sleep)`**, como máquina de estados:
  1. `unlinked`: `register` cada 30 s y `activate` cada 10 s;
  2. `staging`: sube el snapshot (`import_snapshot`);
  3. `awaiting_review`: consulta `link_state` cada 30 s;
  4. `active`: `adopt_cloud` una vez y luego el ciclo normal.
- **Ciclo `active`:** `push`, `pull` y `upload_logs`, en ese orden.
  - **Disparadores:** el aviso MQTT, cada `SYNC_INTERVAL_S`, entradas nuevas en la bandeja (revisada cada `OUTBOX_POLL_S`) y `reconcile` cada `RECONCILE_INTERVAL_S`.
  - Los avisos con `revision <= cloud_revision` se ignoran.
  - Mientras corre un ciclo, cualquier número de disparadores deja **un solo** ciclo pendiente.
- **Revocación:** un `revoked` o un `401` hace `clear_credentials`, regenera el código de vinculación (`regenerate_claim_code`) y regresa a `unlinked`. Los datos locales se quedan como están.
- **Registro:** los errores se registran sin tumbar el proceso, y nunca con secretos ni PIN en los mensajes.
- **Unidad systemd:** `User=acceso`, `UMask=0077`, `EnvironmentFile=/etc/acceso/acceso.env` y `EnvironmentFile=-/etc/acceso/cloud.env`, `Restart=always` y `RestartSec=5`. `python -m acceso.cloud` corre `migrate()` antes de arrancar.

- [ ] **Paso 1: pruebas** (reloj y `sleep` simulados, MQTT falso):
  - recorrido completo `unlinked` → `staging` → `active`, con las llamadas en orden;
  - un aviso MQTT dispara un ciclo, y 5 avisos seguidos durante un ciclo dejan 1 solo ciclo pendiente;
  - un `401` regresa a `unlinked` con un código nuevo y sin credenciales en `cloud.env`;
  - una excepción de red en `pull` no termina el `Runner` y el siguiente ciclo reintenta;
  - el `caplog` no contiene el token ni el `panel_secret`.
- [ ] **Paso 2:** implementar. Pasan la suite completa, `bash -n deploy/*.sh` y `bash deploy/test_install_validation.sh`.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

### Tarea P5: Página "Nube" del panel local

**Archivos:**
- Crear: `backend/acceso/web/routes/cloud.py` (`GET /api/cloud/status`) y `frontend/src/app/(panel)/nube/page.tsx`.
- Modificar:
  - la navegación de `frontend/src/app/(panel)/layout.tsx`;
  - la confirmación de borrado de `frontend/src/app/(panel)/permisos/page.tsx`. Con el panel vinculado, agrega `"Este permiso es un perfil de la instalación: se borrará también en los demás paneles."`.
- Pruebas: `tests/test_api_cloud.py` y `frontend/src/app/(panel)/nube/page.test.tsx`.

**Interfaces:**
- **`GET /api/cloud/status`** devuelve `{panel_code, claim_code | null, state, installation_name | null, last_sync_at | null, cloud_revision, pending_changes, last_error | null}`. `claim_code` solo aparece mientras `state='unlinked'`.
- **Página "Nube":**
  - muestra el identificador en grande, el código de vinculación con "Mostrar/Ocultar" y la instrucción "Captura estos dos datos en la plataforma, en Instalación → Paneles → Vincular panel.";
  - después muestra el estado de la vinculación, la instalación, la última sincronización, los cambios pendientes y el último error;
  - en `staging` o `awaiting_review`, avisa: `"La importación está en revisión en la plataforma. Los cambios que hagas aquí mientras tanto se perderán al adoptar los datos de la nube."`.

- [ ] **Paso 1: pruebas:**
  - sin sesión → 401;
  - vinculado → `claim_code` es `null`;
  - la respuesta nunca contiene `panel_secret` ni el token;
  - la página muestra el `panel_code` y oculta el código hasta presionar "Mostrar".
- [ ] **Paso 2:** implementar. Las suites pasan.
- [ ] **Paso 3:** dejar los cambios sin confirmar; el dueño hace el commit.

## Parte E — Integración y despliegue

### Tarea E1: Prueba de punta a punta y guía de despliegue

**Archivos:**
- Crear: `cloud/e2e/run_e2e.sh`, `cloud/e2e/README.md` y `cloud/docs/despliegue.md`.

**Interfaces:**
- **`run_e2e.sh`:**
  1. levanta `supabase start`, EMQX (`infra/emqx`) y `next dev`;
  2. crea un tenant, un `admin` y una instalación por SQL;
  3. corre `python -m acceso.cloud` del panel contra una base v6 temporal (con 1 titular y 1 tarjeta) y `CLOUD_URL` / `MQTT_URL` locales;
  4. reclama el panel por SQL, con la misma actualización que hace `claimPanel` (leyendo `panel_code` y el código de `sync_state` de la base temporal). No se agrega ningún endpoint solo para pruebas.
- **Comprobaciones:**
  - el panel queda `active` y sus datos aparecen en la nube;
  - una tarjeta dada de alta en la nube aparece en la base del panel en menos de 10 s (aviso MQTT);
  - una tarjeta dada de alta en el panel aparece en la nube en menos de 10 s;
  - un log del panel aparece en la nube;
  - al detener EMQX, la sincronización de respaldo (con `SYNC_INTERVAL_S=20` en E2E) sigue funcionando.
- **`despliegue.md`:**
  - crear el proyecto Supabase (migraciones, Vault con `APP_URL` y secretos, `pg_cron` y `pg_net`);
  - variables de entorno en Vercel;
  - servidor virtual con Docker, EMQX, TLS (Caddy o certbot), puertos 8883 y 443 y la API key;
  - en cada panel: `CLOUD_URL` y `MQTT_URL` en `/etc/acceso/cloud.env`;
  - costos aproximados con la nota "a confirmar con precios vigentes".

- [ ] **Paso 1:** escribir el script y correrlo. Termina con `E2E OK`.
- [ ] **Paso 2:** dejar los cambios sin confirmar; el dueño hace el commit.
