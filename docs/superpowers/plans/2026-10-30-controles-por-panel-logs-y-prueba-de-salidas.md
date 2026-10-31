# Controles por panel, actualizar logs y prueba de salidas — Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans. Los pasos usan casillas (`- [ ]`).

**Objetivo:** que cada botón de un control se vincule por panel en la nube, que la página de logs de la nube pueda pedir los logs al momento y que cada salida se pueda probar desde la web local y desde la nube.

**Arquitectura:**
- **Controles.** La nube suma la tabla replicada `control_button_panels`. El feed, el snapshot, las sumas de verificación, el push y la importación de cada panel proyectan los botones **filtrando por ese panel**, así que el panel local no cambia de esquema (sigue en v6) ni de contrato.
- **Órdenes de la nube.** Viajan por MQTT (`acc/<code>/cmd`) con dos tipos nuevos, `upload_logs` y `test_output`. El agente informa el resultado de la prueba por la API de dispositivos.
- **Relevadores.** El daemon es el único dueño del UART y atiende las pruebas por un socket Unix local.

**Stack:**
- nube: Next.js 16 (Cache Components), Supabase (Postgres, RLS, pgTAP), Zod 4, Vitest;
- panel: Python ≥ 3.9 con FastAPI, SQLite y paho-mqtt; Next.js estático con Vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-controles-por-panel-logs-y-prueba-de-salidas-design.md`. Léelo antes de cada tarea: es la autoridad.

## Global Constraints

- **Git:** no hagas commits ni merges. Los cambios se quedan sin confirmar en `develop` y el dueño los confirma. Donde una plantilla diga "Commit", solo verifica que `git status` muestre tus archivos.
- **Idioma:** toda la interfaz, los mensajes de error y los comentarios de código van en español, igual que el código que los rodea.
- **Panel:**
  - Python ≥ 3.9: sin anotaciones `X | Y`; se usan comentarios `# type:` como en el resto de `acceso`;
  - se mantienen el esquema v6, el protocolo UART v2.2 y el contrato de `/api/device/v1/changes`;
  - la API local de errores responde `{"detail": "<texto en español>"}`.
- **Nube:**
  - la API de dispositivos responde errores como `{code, message}`, con `deviceRoute`;
  - las acciones de servidor devuelven `ActionResult` con `runAction`;
  - en las páginas, `connection()` va antes de cookies u hora (Cache Components);
  - las tablas nuevas llevan RLS, GRANT por columna y `revoke` para `anon`, como `20261027052909_replicated.sql`;
  - las funciones privilegiadas van en el esquema `private`.
- **El PIN nunca aparece** en logs, en el journal ni en MQTT.
- **Constantes:**
  - origen de log nuevo `5` = **"Prueba"**; el `4` queda reservado ("Remota", etapa 3) y no se usa;
  - etiqueta del log de prueba: `"Prueba — web local"` o `"Prueba — <correo>"`;
  - motivo `0` si se activó, `4` (`REASON_UART_ERROR`) si falló el UART.
- **Tiempos:**
  - vigencia de la orden de prueba en la nube: **10 s**; espera de su resultado en la página: **8 s**;
  - "Actualizar logs": espera **15 s** como máximo y acepta una petición por instalación cada **10 s**.
- **Ruta del socket:** `/run/acceso/daemon.sock`, configurable con la variable `DAEMON_SOCKET`.
- **Pruebas:**
  - nube: `cd cloud && npm test`, `npm run test:db` (Supabase local encendido con `npx supabase start`), `npm run lint` y `npx tsc --noEmit`;
  - panel: `cd panel/backend && .venv/bin/pytest`; `cd panel/frontend && npm test && npm run lint && npm run build`.
- **Migraciones de Supabase:** se crean con `cd cloud && npx supabase migration new <nombre>`; el nombre de archivo nunca se inventa. Se aplican en local con `npx supabase db reset` o `npx supabase migration up`. **No** se aplican al proyecto remoto: lo hace el dueño.

## Review Focus

1. **Cambio de código RF en el Panel 1** de un botón que también está vinculado al Panel 2. Llegan un delete de X y un insert de Y con el mismo número de botón. Esperado: Y queda vivo y vinculado solo al Panel 1, X sigue vivo para el Panel 2 y el control no se borra (Tarea 2).
2. **Delete en el feed de un botón o control que el panel no tiene.** Esperado: el panel lo ignora sin error ni alerta (Tarea 3, prueba en `panel/backend/tests/cloud/test_sync.py`).
3. **Daemon detenido o socket inexistente.** Esperado: la web local responde 503 "El daemon no responde" y el agente informa a la nube `ok=false` con ese texto (Tareas 6 y 8).
4. **Orden `test_output` caducada o repetida** (el mismo `command_id` dos veces, o una que llega tarde por una reconexión). Esperado: no se activa el relevador y no se escribe log (Tarea 8).
5. **"Actualizar logs" sin logs pendientes en el panel.** Esperado: `panels.logs_uploaded_at` se actualiza igual y la página deja de esperar antes de 15 s (Tareas 8 y 9).

---

## Mapa de archivos

**Nube**

| Archivo | Responsabilidad |
|---|---|
| `cloud/supabase/migrations/<ts>_control_button_panels.sql` (nuevo) | Tabla de vínculos, migración de datos, quitar `output_index`, unicidad por panel, `claim_panel`, y push SQL de botones y controles |
| `cloud/supabase/migrations/<ts>_panel_commands.sql` (nuevo) | `panel_commands`, `panels.logs_uploaded_at`, `installations.logs_requested_at` |
| `cloud/supabase/tests/control_button_panels.test.sql` (nuevo), `panel_commands.test.sql` (nuevo); ajustes en `replicated.test.sql` | pgTAP |
| `cloud/src/lib/device/projection.ts`, `changes.ts`, `apply.ts`, `imports.ts`, `contract.ts`, `logs.ts` | Proyección por panel, push, importación, logs |
| `cloud/src/lib/device/commands.ts` (nuevo) | Resultado de órdenes (`recordCommandResult`) |
| `cloud/src/app/api/device/v1/command-result/route.ts` (nuevo) | Ruta del resultado |
| `cloud/src/lib/controls.ts`, `src/components/access/ControlForm.tsx`, `ControlsManager.tsx`, `src/app/t/[tenant]/installations/[id]/controles/*` | Interfaz de botones por panel |
| `cloud/src/lib/panel-commands.ts` (nuevo) | `requestLogsUploadAs`, `logsUploadStatusAs`, `testOutputAs`, `commandStatusAs` |
| `cloud/src/app/t/[tenant]/installations/[id]/logs/*`, `salidas/*`, `src/components/access/OutputForm.tsx`, `OutputsManager.tsx`, `src/components/logs/RefreshLogsButton.tsx` (nuevo), `cloud/src/lib/log-view.ts` | Botones "Actualizar logs" y "Probar"; origen 5 |

**Panel**

| Archivo | Responsabilidad |
|---|---|
| `panel/backend/acceso/daemon_socket.py` (nuevo) | Servidor y cliente del socket Unix (JSON) |
| `panel/backend/acceso/output_test.py` (nuevo) | `OutputTester`: prueba de salida con candado, registro y "ya se está probando" |
| `panel/backend/acceso/daemon.py`, `config.py`, `constants.py` | Arranque del socket, `send` compartido con candado, `daemon_socket`, `SOURCE_TEST` |
| `panel/deploy/acceso-daemon.service`, `deploy/env.example` | `RuntimeDirectory=acceso`, `DAEMON_SOCKET` |
| `panel/backend/acceso/web/routes/outputs.py`, `routes/logs.py` | `POST /api/outputs/{id}/test`; filtro de origen hasta 5 |
| `panel/frontend/src/components/OutputForm.tsx`, `app/(panel)/salidas/page.tsx`, `lib/format.ts`, `components/LogFilters.tsx` | Botón "Probar" y origen "Prueba" |
| `panel/backend/acceso/cloud/commands.py` (nuevo) | `CommandWorker`: valida, deduplica, llama al daemon e informa |
| `panel/backend/acceso/cloud/mqtt_link.py`, `runner.py`, `api.py`, `sync.py`, `__main__.py` | Tipos MQTT nuevos, subida de logs al momento, `post_command_result` |

---

### Tarea 1: Esquema de vínculos botón–panel en la nube

**Archivos:**
- Crear: la migración `control_button_panels` (con `npx supabase migration new control_button_panels`) y `cloud/supabase/tests/control_button_panels.test.sql`.
- Modificar: `cloud/supabase/tests/replicated.test.sql` (conteos de RLS e índices, e inserts con `output_index` en `control_buttons` a partir de la línea 147).

**Interfaces:**
- Produce la tabla `public.control_button_panels`, con estas columnas:
  - `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null`;
  - `installation_id uuid not null references installations on delete cascade`;
  - `button_id uuid not null` y `panel_id uuid not null references panels(id)`;
  - `output_index int null check (0..3)`;
  - `updated_at`, `updated_by`, `origin`, `deleted_at` y `revision`, como las demás tablas replicadas;
  - FK `(installation_id, button_id)` hacia `control_buttons (installation_id, id)` con `on delete cascade`. Si `control_buttons` no tiene un `unique (installation_id, id)`, se agrega.
- Produce el índice único vivo `control_button_panels_button_panel_live_key (button_id, panel_id) where deleted_at is null`.
- Produce la función `private.check_button_panel_unique()`, que lanza `unique_violation` con `constraint = 'control_button_panels_panel_button_live_key'`. La comprueban los disparadores de `control_button_panels` (insert, y update de `deleted_at` o `panel_id`) y de `control_buttons` (update de `button`, `control_id` o `deleted_at`).
  - Regla: entre los vínculos vivos de un panel cuyos botones están vivos, `(control_id, button)` no se repite.
- `control_buttons` pierde `output_index`, y se borra `control_buttons_control_button_live_key`.

- [ ] **Paso 1: escribir el pgTAP fallido** en `control_button_panels.test.sql`. Debe probar lo siguiente:
  - la tabla existe con RLS activo; `authenticated` puede insertar y actualizar `(installation_id, button_id, panel_id, output_index)` y `(output_index, deleted_at)`;
  - insertar un vínculo de otra instalación o de un panel de otra instalación da `23503` o `P0001`, igual que `check_panel_installation` en outputs;
  - dos vínculos vivos al mismo `(button_id, panel_id)` dan `23505`;
  - dos botones vivos del mismo control con el mismo `button`:
    - vinculados al **mismo** panel, dan `23505`;
    - vinculados a paneles **distintos**, se aceptan;
  - `control_buttons` ya no tiene la columna `output_index`;
  - la migración de datos no se prueba con pgTAP, porque la columna ya no existe después: se verifica a mano en el Paso 4b;
  - **`claim_panel`:** al reclamar un panel en otra instalación, sus vínculos vivos de la instalación anterior quedan con `deleted_at`;
  - **cascada:** al borrar lógicamente un botón, sus vínculos heredan `deleted_at` (la cascada lógica la hace `replicated_soft_delete_cascade('control_button_panels', 'button_id')` sobre `control_buttons`);
  - la auditoría y la revisión se generan como en las demás tablas replicadas.
- [ ] **Paso 2:** correr `cd cloud && npm run test:db` y confirmar que **falla** porque la tabla no existe.
- [ ] **Paso 3: escribir la migración.** Empieza por la estructura:
  - **Tabla:** se crea la tabla y se suma a los dos arreglos de tablas replicadas, como en `20261027052909_replicated.sql:218` y `:408`:
    - índices `(installation_id, revision)` y `(tenant_id)`;
    - disparador de auditoría;
    - políticas `select`, `insert` y `update` con `private.is_member`;
    - grants.
  - **Escritura replicada:** `control_button_panels_before_write` con `private.replicated_before_write('button_id', 'control_buttons')`.
  - **Panel de la misma instalación:** `check_panel_installation` (`20261027060242_panels.sql:105-132`).
  - **Auditoría:** `audit_log.table_name` admite `'control_button_panels'`.
  - **Cascada:** la de `control_buttons` pasa a cubrir los vínculos.

  Después, los datos y la limpieza, en este orden:
  1. **Migración de datos:** se inserta un vínculo por cada botón vivo y cada panel de la instalación con `status in ('claimed', 'staging', 'awaiting_review', 'active')`, con `updated_by = 'system:migracion'` y `origin = 'cloud'`. Para ver cómo firmar sin `auth.uid()`, mira `20261028165920_claim_panel_neutral_author.sql`.
  2. Se quita `output_index` de los grants de `control_buttons`, se borra la columna y se borra el índice `control_buttons_control_button_live_key`.
  3. Se recrea `claim_panel` igual a la versión vigente (la de `claim_panel_neutral_author`), y además borra lógicamente los vínculos vivos del panel en otra instalación.
  4. Disparadores de unicidad por panel con `private.check_button_panel_unique()`.

  El `push_row` y el `apply_panel_change` se tocan en la Tarea 2, en esta misma migración.
- [ ] **Paso 4:** correr `npx supabase db reset && npm run test:db`. Esperado: todo pasa, incluido `replicated.test.sql` ajustado.
- [ ] **Paso 4b: verificar la migración de datos.** Esta verificación borra los datos de la base local:
  1. `npx supabase db reset --version 20261028165920` (la base local queda en la migración anterior).
  2. Con SQL, crear un tenant, una instalación, dos paneles (`claimed` y `active`), un titular, un control y dos botones: uno con `output_index = 2` y otro con `null`.
  3. `npx supabase migration up`.
  4. Comprobar que hay 4 vínculos, con `output_index` 2, 2, `null` y `null`, y con `origin = 'cloud'` y `updated_by = 'system:migracion'`.
  5. Anotar el resultado en el informe y terminar con `npx supabase db reset`.
- [ ] **Paso 5:** `get_advisors` del Supabase local (MCP `supabase-local`) o `npx supabase db advisors`, sin avisos nuevos de seguridad.

### Tarea 2: Push desde el panel con semántica por panel (SQL + `apply.ts`)

**Archivos:**
- Modificar: la misma migración de la Tarea 1 (se agrega al final), `cloud/src/lib/device/apply.ts` y `cloud/src/lib/device/projection.ts` (`liveRow` para `current`).
- Pruebas: `cloud/tests/device/push.test.ts` y `cloud/supabase/tests/control_button_panels.test.sql`.

**Interfaces:**
- Consume la tabla y las reglas de la Tarea 1.
- Mantiene el contrato de push: `PushResult {change_id, status: "applied"|"superseded"|"rejected", revision?, reason?, current?}`.
- Produce la razón nueva `"fusionado"` (status `rejected`, `current: null`).
- Cómo aplica `public.apply_panel_change(...)` (misma firma) cuando `p_table = 'control_buttons'`, con `P = p_panel_id`:
  - **upsert de un id existente y vivo:**
    1. `control_id`, `button` y `rf_code` van con `push_row` y LWW, como hoy;
    2. el vínculo `(id, P)` se crea o se actualiza con `output_index = data.output_id`, con LWW sobre el `updated_at` del vínculo. Si el vínculo estaba borrado lógicamente, se revive.
  - **upsert de un id nuevo:**
    - se inserta el botón y su vínculo con P;
    - si choca con `control_buttons_rf_code_live_key`, depende del titular:
      - **mismo titular:** el control del botón vivo B' tiene el mismo `holder_id` que el control `data.control_id`. Se **fusiona**: se crea o actualiza el vínculo `(B', P)` con esa salida y se responde `rejected`/`fusionado`. Si el control `data.control_id` se queda sin botones vivos y su `origin = 'panel:' || P`, se borra lógicamente;
      - **otro titular:** `rejected`/`duplicado`, como hoy.
  - **delete:** borra lógicamente el vínculo `(id, P)`. Si el botón se queda sin vínculos vivos, se borra lógicamente el botón. El control **no** se borra.
- Cuando `p_table = 'controls'`, la operación delete hace lo siguiente:
  - borra lógicamente los vínculos con P de todos los botones del control;
  - borra los botones que se quedan sin vínculos;
  - borra el control **solo** si después no le queda ningún botón vivo.

  Upsert de `controls` igual que hoy.
- `liveRow(admin, panel, "control_buttons", id)` devuelve la proyección para ese panel: `output_id` del vínculo con el panel, o `null` si no hay vínculo vivo. Si no hay vínculo, el `current` es `null`.

- [ ] **Paso 1: escribir las pruebas fallidas** en `push.test.ts`, con dos paneles activos en la misma instalación (copia la preparación que ya usa el archivo):
  - `cambio de salida en el Panel 1 cambia solo su vínculo`: el vínculo del Panel 2 conserva su salida.
  - `alta de botón nuevo en el Panel 1 queda vinculada solo al Panel 1`.
  - `código RF existente con el mismo titular se fusiona`: `status rejected`, `reason "fusionado"`, `current null`; el vínculo `(B', Panel 2)` existe con la salida enviada; el control vacío que creó el Panel 2 tiene `deleted_at`.
  - `código RF existente con otro titular se rechaza como duplicado`.
  - `borrado en el Panel 1 de un botón vinculado a ambos solo quita el vínculo del Panel 1`: el botón sigue vivo.
  - `cambio de código RF en el Panel 1`, que cubre el punto 1 de Review Focus: en un mismo push van el delete de X y el insert de Y con el mismo número. Los dos dan `applied`; X sigue vivo con el vínculo del Panel 2; Y existe con un vínculo solo al Panel 1; el control sigue vivo.
  - `borrado de botón que deja el control vacío no borra el control`.
  - `borrado de control en el Panel 1 con botones vinculados al Panel 2`: el control sigue vivo y los botones del Panel 2 siguen vinculados.
  - Se actualizan las aserciones existentes que leen `control_buttons.output_index`, en las líneas 270, 390-395, 633 y 841-857.
- [ ] **Paso 2:** correr `cd cloud && npx vitest run tests/device/push.test.ts` y confirmar que **falla**.
- [ ] **Paso 3: implementar** en SQL, dentro de `apply_panel_change`, con una rama para `control_buttons` y otra para el delete de `controls`. Todo se hace bajo el mismo candado de la instalación y la misma idempotencia de `device_changes`. Para el nuevo valor del vínculo:
  - se reutiliza `push_row` con `p_table = 'control_button_panels'`, agregando su lista de columnas y su alcance `panel_id = $3`;
  - o se escribe una función privada `private.push_button_link(...)`. Lo decides tú.

  `apply.ts` mantiene la conversión `output_id`→`output_index` solo para `outputs` y pasa `data` tal cual para `control_buttons`. La función SQL lee `data->>'output_id'`.
- [ ] **Paso 4:** correr `npx vitest run tests/device/push.test.ts && npm run test:db`. Esperado: todo pasa.

### Tarea 3: Lo que recibe cada panel (feed, snapshot y sumas de verificación)

**Archivos:**
- Modificar: `cloud/src/lib/device/projection.ts` y `cloud/src/lib/device/changes.ts`.
- Pruebas: `cloud/tests/device/pull.test.ts`, `cloud/tests/device/linking.test.ts:114` (si lee `output_index`) y `panel/backend/tests/cloud/test_sync.py`, una prueba nueva para el punto 2 de Review Focus.

**Interfaces:**
- **`visibleToPanel(admin, panel, controlId): Promise<boolean>`** (nueva, en `projection.ts`). Es `true` si el control está vivo y además cumple una de dos condiciones:
  - tiene algún botón vivo con vínculo vivo al panel;
  - o no tiene ningún botón vivo.
- **`liveRows(admin, panel, "control_buttons")`:** solo los botones vivos con vínculo vivo al panel, con `output_id` del vínculo.
- **`liveRows(admin, panel, "controls")`:** solo los controles visibles para el panel. Las dos funciones alimentan `panelSnapshot` y `panelChecksums`.
- **`listChanges(panel, since, limit)`:** misma firma y mismo contrato. En las fuentes de cambios entra `control_button_panels`, filtrada por `panel_id`. Cada cambio de `control_buttons` o `control_button_panels` que afecta al botón B se proyecta así:
  - **B vivo y con vínculo vivo al panel:** `upsert` de B, precedido de un `upsert` de su control si en esa página todavía no salió.
  - **Si no:** `delete` de B, seguido de la operación de su control: `delete` si el control dejó de ser visible para el panel, o `upsert` si ahora es visible por haberse quedado sin botones.
  - **Cambios de `controls`:** `upsert` si el control es visible, y `delete` si no lo es.
  - Dentro de una página, una misma `(tabla, id)` puede repetirse: el panel aplica en orden y es idempotente.

- [ ] **Paso 1: escribir las pruebas fallidas** en `pull.test.ts`, con dos paneles:
  - `el Panel 2 no recibe un botón vinculado solo al Panel 1`, ni su control si todos sus botones son del Panel 1;
  - `cada panel recibe su propia salida del mismo botón`;
  - `desvincular el Panel 2 le envía delete del botón y del control`;
  - `vincular por primera vez al Panel 2 le envía upsert del control antes que el del botón` (comprueba el orden en `changes`);
  - `un control sin botones llega a ambos paneles`;
  - `panelChecksums` y `panelSnapshot` del Panel 2 excluyen los botones y controles del Panel 1;
  - se actualizan las aserciones que leen `output_index`, en las líneas 280-281 y 403-409.
- [ ] **Paso 2:** correr `npx vitest run tests/device/pull.test.ts` y confirmar que **falla**.
- [ ] **Paso 3: implementar.** `SOURCE_COLUMNS.control_buttons` deja de pedir `output_index`; la salida se toma del vínculo con el panel. `PANEL_SOURCES` suma `control_button_panels`. `TABLA_LOCAL` no cambia, porque el vínculo se proyecta como `control_buttons`.
- [ ] **Paso 4: escribir una prueba** en `panel/backend/tests/cloud/test_sync.py`: `test_pull_delete_de_uuid_desconocido_no_falla`. Un feed con `delete` de un `control_buttons` y de un `controls` cuyos uuid no existen en el panel se aplica sin excepción, avanza la revisión y no deja alerta. Si falla, corrige `mapping.py` para que el delete de un uuid desconocido no haga nada.
- [ ] **Paso 5:** correr `npx vitest run tests/device && cd ../panel/backend && .venv/bin/pytest tests/cloud`. Esperado: todo pasa.

### Tarea 4: Importación de un panel con controles por panel

**Archivos:**
- Modificar: `cloud/src/lib/device/imports.ts`, la migración de la Tarea 1 (al final, `private.import_rows`) y `cloud/src/components/panels/ImportReview.tsx` (solo si cambia algún tipo).
- Pruebas: `cloud/tests/device/import.test.ts` y `cloud/supabase/tests/imports.test.sql` (si toca los inserts de botones).

**Interfaces:**
- `ImportPlan.control_buttons[]` deja de llevar `output_index`. Se suma `ImportPlan.control_button_links: {button_id: string, output_index: number|null}[]`: un vínculo con el panel que importa por cada botón que queda en la nube y que el panel tenía, sea uno nuevo (que solo existía en el panel) o uno que la nube ya tenía con el mismo titular (`botonNube`).
- `private.import_rows(...)`:
  - inserta los botones sin `output_index`;
  - inserta `control_button_panels` para `p_panel_id` desde `p_plan->'control_button_links'`, traduciendo los ids nuevos con `import_id`;
  - el autor y el origen son los mismos que usa hoy para los demás registros.
- `computeImportDiff`: un botón "ya está" (mismo `rf_code` y mismo titular) **no es una diferencia**, pero genera su vínculo con la salida local (`output_id` del snapshot).

- [ ] **Paso 1: escribir las pruebas fallidas** en `import.test.ts`:
  - `importar un panel a una instalación vacía vincula sus botones solo a ese panel`;
  - `un botón que la nube ya tiene con el mismo titular queda vinculado al panel nuevo con su salida local`;
  - `los botones de la nube que el panel no tiene no se vinculan al panel nuevo`;
  - se actualizan las aserciones en las líneas 111, 143-171 y 255.
- [ ] **Paso 2:** correr `npx vitest run tests/device/import.test.ts` y confirmar que **falla**.
- [ ] **Paso 3: implementar** `planBoton`, `directPlan`, `confirmPlan` y `loadCloudState`, y el SQL de `import_rows`.
- [ ] **Paso 4:** correr `npx vitest run tests/device && npm run test:db`. Esperado: todo pasa.

### Tarea 5: Interfaz de controles con salida por panel (nube)

**Archivos:**
- Modificar: `cloud/src/lib/controls.ts`, `cloud/src/lib/access-view.ts`, `cloud/src/components/access/ControlForm.tsx`, `cloud/src/components/access/ControlsManager.tsx` y `cloud/src/app/t/[tenant]/installations/[id]/controles/page.tsx` y `actions.ts`.
- Pruebas: `cloud/tests/ui/controls.test.tsx` y `cloud/tests/ui/access-data.test.ts`.

**Interfaces:**
- Tipos nuevos en `controls.ts`:
  - `ButtonInput { id: string | null; button: number; rf_code: number | null; outputs: Record<string /* panel_id */, number | null> }`;
  - `ControlInput { holder_id; description; buttons: ButtonInput[] }`, con 0 a 8 botones;
  - `ButtonRow { id; button; rf_code; outputs: Record<string, number | null> }`.
- `listControlsAs`, `createControlAs`, `updateControlAs` y `deleteControlAs` conservan sus firmas.
- `ControlsPage` suma `panels: {id, panel_code, aliases: (string|null)[]}[]` (paneles vinculados, con `isLinkedPanel`, y los alias de sus salidas, tomados de `listOutputsAs`) y los pasa a `ControlsManager` → `ControlForm`.
- **Reglas de validación** (`HttpError(400)`, en español):
  - `button` debe estar entre 0 y 3;
  - los códigos no se repiten dentro del control;
  - en un mismo panel, dos botones con salida no pueden compartir número: "Dos botones con el número N van al panel X.";
  - `panel_id` debe ser un panel vinculado de la instalación.
- **Botón sin salida en ningún panel:**
  - si es nuevo, no se crea;
  - si ya existe, se borra lógicamente. La interfaz pide confirmación con `window.confirm("El botón N no tiene salida en ningún panel y se borrará. ¿Continuar?")`.
- **Escritura:**
  - el botón se crea con `control_buttons`;
  - por cada panel, se inserta el vínculo, se cambia su `output_index` o se borra lógicamente. Todo como el usuario y con RLS, siguiendo el patrón actual de `updateControlAs`;
  - si cambia `rf_code` en un botón existente, se actualiza la fila (esta es la nube, no un panel).
- **Interfaz:**
  - `ControlForm` muestra una fila por botón vivo y filas vacías para los números libres, hasta 4 números;
  - cada fila lleva el código RF y un `<select>` por panel, con opciones "Ninguna" y S1–S4, mostrando el alias cuando existe ("S1 · Pluma vehicular");
  - una instalación sin paneles vinculados muestra "Vincula un panel para asignar salidas a los botones.";
  - en `ControlsManager`, cada botón se lista como `Botón N: código → PNL-XXXX S1, PNL-YYYY —`.
  - Usa las skills `frontend-design` y `vercel-react-best-practices` y las clases existentes (`field`, `btn`, `tag`).

- [ ] **Paso 1: escribir las pruebas fallidas:**
  - **en `access-data.test.ts`:**
    - `createControlAs con un botón al Panel 1 S1 y al Panel 2 ninguna crea un solo vínculo`;
    - `updateControlAs que cambia la salida del Panel 2 solo toca ese vínculo`;
    - `botón sin salida en ningún panel se borra`;
    - `dos botones con el mismo número al mismo panel dan 400`;
    - `un técnico puede editar y un usuario de otro tenant no`;
  - **en `controls.test.tsx`:**
    - el formulario muestra un selector por panel con el alias;
    - al enviar, se arma `ButtonInput.outputs` con cada panel;
    - quitar todas las salidas pide confirmación.
- [ ] **Paso 2:** correr `npx vitest run tests/ui/controls.test.tsx tests/ui/access-data.test.ts` y confirmar que **falla**.
- [ ] **Paso 3: implementar** según las interfaces.
- [ ] **Paso 4:** correr `npm test && npm run lint && npx tsc --noEmit`. Esperado: todo pasa.

### Tarea 6: Socket del daemon y prueba de salida (panel)

**Archivos:**
- Crear: `panel/backend/acceso/daemon_socket.py`, `panel/backend/acceso/output_test.py`, `panel/backend/tests/test_daemon_socket.py` y `panel/backend/tests/test_output_test.py`.
- Modificar: `panel/backend/acceso/daemon.py`, `config.py` y `constants.py`, `panel/deploy/acceso-daemon.service`, `panel/deploy/env.example`, y `panel/backend/tests/test_daemon.py` (una prueba de integración).

**Interfaces:**
- **`constants.py`:** `SOURCE_TEST = 5`.
- **`config.py`:** `Settings.daemon_socket: str = "/run/acceso/daemon.sock"`, un campo con valor por omisión al **final** del dataclass para no romper `tests/conftest.py`, que viene de la variable `DAEMON_SOCKET`.
- **`daemon_socket.py`:**
  - `class DaemonUnavailable(Exception)`;
  - `def request_daemon(path: str, payload: Mapping[str, Any], timeout: float = 3.0) -> Dict[str, Any]`:
    - se conecta y envía una línea JSON;
    - lee una línea JSON de respuesta;
    - si el socket no existe, rechaza la conexión, se pasa del tiempo o la respuesta no es válida, lanza `DaemonUnavailable("El daemon no responde")`;
  - `class DaemonSocketServer`:
    - constructor `__init__(self, path: str, handler: Callable[[Dict[str, Any]], Dict[str, Any]])`; métodos `start() -> None` (hilo propio) y `stop() -> None`;
    - borra un socket viejo que haya quedado en la ruta y crea el nuevo con permisos 0600;
    - atiende una petición por conexión, de 4096 bytes como máximo y con 2 s de tiempo límite;
    - si el JSON es inválido o el handler lanza una excepción, responde `{"ok": false, "detail": "Petición inválida."}` o `"Error interno."`.
- **`output_test.py`:**
  - `class RelayLink`: guarda el `send` actual protegido con un `threading.Lock`. Métodos:
    - `set(send: Optional[Callable[[bytes], None]]) -> None`;
    - `send(frame: bytes) -> None`, que lanza `OSError("Puerto serie no disponible")` si no hay `send`.
  - `class OutputTester`:
    - constructor `__init__(self, db_path, relay: RelayLink, max_entries: int, clock=time.monotonic, wall=time.time)`;
    - método `handle(self, request: Dict[str, Any]) -> Dict[str, Any]`, que atiende `{"op": "test_output", "output": int, "requested_by": str}`.
  - **Validación**, antes de tocar el relevador:
    - `op` debe ser `"test_output"`;
    - `output` entero de 0 a 3, sin `bool`;
    - `requested_by` de 1 a 120 caracteres, sin caracteres de control.

    Si algo no cumple, responde `{"ok": false, "detail": "Petición inválida."}`.
  - **Cómo funciona:**
    - abre su propia conexión `connect(db_path)` por petición;
    - lee `duration_ms` de la salida, **sin** filtrar por `enabled`; si no existe, responde "La salida N no existe.";
    - si `clock() < busy_until[output]`, responde `{"ok": false, "detail": "La salida ya se está probando"}`;
    - si no, envía `build_relay_command(output, duration_ms)` por `relay.send` y fija `busy_until = clock() + duration_ms / 1000`.
  - **Registro:** escribe con `append_log` usando `source = SOURCE_TEST`, `credential_label = "Prueba — " + requested_by`, `output_id = output`, `timestamp` de `wall()` (en la misma unidad que usa `access.py`) y `max_entries`:
    - si el envío funcionó, `allowed = True` y `reason = REASON_ALLOWED`;
    - si `OSError`, `allowed = False` y `reason = REASON_UART_ERROR`, y responde `{"ok": false, "detail": "No se pudo enviar la orden al relevador."}`.
  - **Respuesta en caso de éxito:** `{"ok": true}`.
- **`daemon.py`:**
  - `run_daemon` crea un `RelayLink` y un `DaemonSocketServer(settings.daemon_socket, tester.handle)` antes del ciclo, y los detiene al salir;
  - `_serve` hace `relay.set(send)` al abrir el puerto y `relay.set(None)` al cerrarlo;
  - `handle_event` envía por `relay.send`, el mismo candado que usa la prueba;
  - si el socket no se puede crear (por ejemplo, porque falta el directorio), registra un aviso y el daemon sigue funcionando sin pruebas;
  - `run_daemon` suma el parámetro `socket_server_factory`, con `DaemonSocketServer` como valor por omisión, para las pruebas.
- **Despliegue:**
  - `acceso-daemon.service` suma `RuntimeDirectory=acceso` y `RuntimeDirectoryMode=0750`;
  - `env.example` documenta `DAEMON_SOCKET` con el comentario "solo cambia en desarrollo (Mac)".

- [ ] **Paso 1: escribir las pruebas fallidas:**
  - **en `test_output_test.py`**, con una `conn` temporal y un `send` falso que registra las tramas:
    - `test_activa_con_duracion_configurada`: la trama es `build_relay_command(1, 3000)` y la respuesta es `{"ok": True}`;
    - `test_registra_log_prueba`: `source = 5`, `allowed = 1`, `reason = 0`, `credential_label = "Prueba — web local"` y `output_id = 1`;
    - `test_salida_deshabilitada_tambien_se_prueba`;
    - `test_segunda_prueba_dentro_de_la_duracion_se_rechaza` (con un reloj falso), que responde "La salida ya se está probando";
    - `test_sin_puerto_registra_error_uart`: `reason = 4`, `allowed = 0` y la respuesta es de error;
    - `test_peticion_invalida`: casos `output = 7`, `output = True`, `requested_by` con `"\n"` y `op` desconocido;
  - **en `test_daemon_socket.py`**, con la ruta en `tmp_path`:
    - ida y vuelta por el socket;
    - `request_daemon` sobre una ruta que no existe lanza `DaemonUnavailable`;
    - JSON inválido devuelve `ok false`;
    - el archivo del socket tiene permisos 0600;
  - **en `test_daemon.py`:** con el `FakeSerial` y el socket en `tmp_path`, una petición `test_output` escribe la trama en el puerto falso.
- [ ] **Paso 2:** correr `cd panel/backend && .venv/bin/pytest tests/test_output_test.py tests/test_daemon_socket.py tests/test_daemon.py` y confirmar que **falla**.
- [ ] **Paso 3: implementar** según las interfaces.
- [ ] **Paso 4:** correr `.venv/bin/pytest`. Esperado: todo pasa (453 pruebas más las nuevas).

### Tarea 7: Botón "Probar" y origen "Prueba" en la web local

**Archivos:**
- Modificar:
  - backend: `panel/backend/acceso/web/routes/outputs.py` y `routes/logs.py`;
  - frontend: `panel/frontend/src/components/OutputForm.tsx`, `src/app/(panel)/salidas/page.tsx`, `src/lib/format.ts` y `src/components/LogFilters.tsx`.
- Pruebas: `panel/backend/tests/test_api_outputs.py` y `test_api_logs.py`, y en el frontend `OutputForm.test.tsx`, `salidas/page.test.tsx` y `format.test.ts`.

**Interfaces:**
- **`POST /api/outputs/{output_id}/test`:** sin cuerpo y con sesión. Responde:
  - 404 "La salida N no existe." si no está en `outputs`;
  - si existe, llama a `request_daemon(settings.daemon_socket, {"op": "test_output", "output": output_id, "requested_by": "web local"})` en el threadpool, dentro de un handler `def` síncrono;
  - `{"ok": true}` → 200 `{"detail": "Salida activada"}`;
  - `{"ok": false, "detail": d}` → 409 `{"detail": d}`;
  - `DaemonUnavailable` → 503 `{"detail": "El daemon no responde"}`.
  - **Para las pruebas:** la función de petición se toma de `request.app.state.daemon_request` si existe y, si no, de `request_daemon`.
- **`GET /api/logs`:** `source` acepta hasta 5 (`le=5`).
- **Frontend:**
  - `SOURCES[5] = "Prueba"`;
  - `mediumLabel` con `source === 5` devuelve `credential_label ?? "Prueba"`;
  - `LogFilters` suma la opción "Prueba" (valor 5);
  - `OutputForm` suma la prop `onTest: () => Promise<void>` y un botón `type="button"` con el texto "Probar {name}", que dice "Probando…" mientras espera;
  - la página muestra "Salida activada" en `role="status"` o el error en `role="alert"`.

- [ ] **Paso 1: escribir las pruebas fallidas:**
  - **backend:**
    - `test_probar_salida_ok` (con `app.state.daemon_request` falso, verifica 200 y que el payload incluye `"requested_by": "web local"`);
    - `test_probar_salida_daemon_caido_503`;
    - `test_probar_salida_ocupada_409`;
    - `test_probar_salida_inexistente_404`;
    - `test_probar_sin_sesion_401`;
    - `test_logs_filtra_origen_5`.
  - **frontend:**
    - `OutputForm` llama a `onTest` al pulsar "Probar S1" y no envía el formulario;
    - la página muestra "Salida activada";
    - `mediumLabel({source: 5, credential_label: "Prueba — web local"})` devuelve ese texto.
- [ ] **Paso 2:** correr las pruebas y confirmar que **fallan**.
- [ ] **Paso 3: implementar.**
- [ ] **Paso 4:** correr `cd panel/backend && .venv/bin/pytest` y `cd panel/frontend && npm test && npm run lint && npm run build`. Esperado: todo pasa.

### Tarea 8: Agente — órdenes `upload_logs` y `test_output`

**Archivos:**
- Crear: `panel/backend/acceso/cloud/commands.py` y `panel/backend/tests/cloud/test_commands.py`.
- Modificar: `panel/backend/acceso/cloud/mqtt_link.py`, `runner.py`, `api.py`, `sync.py` y `__main__.py`, y las pruebas `tests/cloud/test_mqtt_link.py`, `test_runner.py`, `test_sync.py` y `fake_cloud.py`.

**Interfaces:**
- **`MqttLink`** suma el parámetro `on_command: Optional[Callable[[Dict[str, Any]], None]] = None`, por nombre y después de `on_sync`.
  - `_handle_message` sigue llamando a `on_sync` con `type == "sync"`;
  - con `type` en `{"upload_logs", "test_output"}` llama a `on_command(body)`;
  - ignora cualquier otro tipo;
  - si la llamada lanza una excepción, solo registra el tipo de la excepción.
- **`CloudApi.post_command_result(command_id: str, ok: bool, detail: Optional[str]) -> None`:** hace `POST /command-result` con `{"command_id", "ok", "detail"}` y autenticación, siguiendo el patrón de `post_alert`.
- **`SyncEngine.upload_logs(self, *, always_post: bool = False) -> int`:** con `always_post=True` y sin logs pendientes, hace un `post_logs([])`.
- **`commands.py`:**
  - `class CommandWorker`, con constructor `__init__(self, daemon_request: Callable[[str, Mapping[str, Any]], Dict[str, Any]], socket_path: str, post_result: Callable[[str, bool, Optional[str]], None], wall=time.time)`;
  - métodos:
    - `submit(body: Dict[str, Any]) -> None`, que pone en cola y no bloquea;
    - `start() -> None`, que inicia un hilo daemon;
    - `stop() -> None`;
  - **Validación**, antes de ejecutar nada:
    - `command_id` es un UUID;
    - `output` entero de 0 a 3, sin `bool`;
    - `requested_by` es texto de 1 a 120 caracteres;
    - `expires_at` es ISO 8601 con zona horaria.

    Si algo falla, la orden se descarta sin informar.
  - **Orden caducada** (`wall() > expires_at`): se descarta y se registra `log.info`, sin informar.
  - **`command_id` ya visto:** se descarta. Se recuerdan los últimos 256, en un `OrderedDict`.
  - **Orden válida:** se llama a `daemon_request(socket_path, {"op": "test_output", "output", "requested_by"})` y luego a `post_result(command_id, resp["ok"], resp.get("detail"))`.
    - Si lanza `DaemonUnavailable`, se informa `post_result(command_id, False, "El daemon no responde")`.
    - Si `post_result` falla, solo se registra `log.warning` con el tipo de la excepción.
- **`Runner`:**
  - suma el parámetro `command_worker_factory: Optional[Callable[[CloudApi], Any]] = None`;
  - pasa a la fábrica de MQTT `on_command=self._command` por nombre;
  - `_command(body)` corre en el hilo de paho:
    - con `upload_logs`, activa una bandera protegida por candado (como `_notice`);
    - con `test_output`, llama a `worker.submit(body)` si el estado es `active` y el worker existe.
  - En `_active`, si la bandera está activa y no corre un ciclo, ejecuta `engine.upload_logs(always_post=True)` con la etiqueta "Subida de logs", con el mismo manejo de errores y revocación que `_run_cycle`, y baja la bandera.
  - El worker usa **su propia** instancia de `CloudApi`, autenticada con las mismas credenciales, porque `CloudApi` no es seguro entre hilos. La crea `__main__.py` con `CommandWorker(request_daemon, settings.daemon_socket, api2.post_command_result)`.
  - El worker se detiene con `close()`.

- [ ] **Paso 1: escribir las pruebas fallidas:**
  - **`test_commands.py`:**
    - `test_orden_valida_llama_al_daemon_e_informa`;
    - `test_orden_caducada_no_llama_al_daemon`;
    - `test_command_id_repetido_se_ejecuta_una_vez`;
    - `test_daemon_caido_informa_false`;
    - `test_campos_invalidos_se_descartan`: `output` igual a `"1"`, `expires_at` sin zona y `command_id` que no es UUID;
    - `test_fallo_al_informar_no_tumba_el_hilo`.
  - **`test_mqtt_link.py`:** `upload_logs` y `test_output` llegan a `on_command`; un tipo desconocido no llega; `sync` sigue llegando a `on_sync`.
  - **`test_runner.py`:**
    - con `upload_logs` en `active` se ejecuta `upload_logs(always_post=True)` en el siguiente tick, sin push ni pull;
    - con `test_output` en `active` se llama a `submit`, y en `staging` no;
    - se actualizan `Harness.mqtt_factory` y `FakeMqtt` para aceptar `on_command`.
  - **`test_sync.py`:** `upload_logs(always_post=True)` sin logs pendientes hace un POST con lista vacía. Un log con `source = 5` sube tal cual: si `fake_cloud.LOG_SCHEMA` limita el origen, se amplía a 5.
- [ ] **Paso 2:** correr `.venv/bin/pytest tests/cloud` y confirmar que **falla**.
- [ ] **Paso 3: implementar.**
- [ ] **Paso 4:** correr `.venv/bin/pytest`. Esperado: todo pasa.

### Tarea 9: Nube — órdenes, resultado y logs al momento (datos y API de dispositivos)

**Archivos:**
- Crear:
  - la migración `panel_commands`, con `npx supabase migration new panel_commands`;
  - `cloud/supabase/tests/panel_commands.test.sql`;
  - `cloud/src/lib/device/commands.ts` y `cloud/src/app/api/device/v1/command-result/route.ts`;
  - las pruebas `cloud/tests/device/command-result.test.ts` y `cloud/tests/ui/panel-commands.test.ts`;
  - `cloud/src/lib/panel-commands.ts`.
- Modificar: `cloud/src/lib/device/contract.ts`, `cloud/src/lib/device/logs.ts` y `cloud/tests/device/logs.test.ts`.

**Interfaces:**
- **SQL:**
  - `public.panel_commands`:
    - columnas: `id uuid pk`, `tenant_id`, `installation_id`, `panel_id` (FK a `panels`), `kind text check (kind = 'test_output')`, `output_index int check (0..3)`, `requested_by text not null`, `requested_by_user uuid`, `created_at timestamptz default now()`, `expires_at timestamptz not null`, `status text check (status in ('pending','ok','error','expired')) default 'pending'`, `detail text` y `finished_at timestamptz`;
    - RLS con un `select` para `private.is_member(tenant_id)`, sin `insert`, `update` ni `delete` para `authenticated` y sin grants para `anon`;
    - índice `(panel_id, output_index, status)`.
  - `panels.logs_uploaded_at timestamptz`, con su `select` en el grant de columnas de `panels`.
  - `installations.logs_requested_at timestamptz`, que solo escribe el `service_role`.
- **`contract.ts`:**
  - `commandResultSchema = z.strictObject({command_id: uuidSchema, ok: z.boolean(), detail: z.string().max(200).nullable().optional()})`;
  - `logsRequestSchema` acepta una lista vacía;
  - `logItemSchema` acepta `source` 5.
- **`logs.ts` (`storeLogs`):** siempre actualiza `panels.logs_uploaded_at = now()` del panel, aunque la lista venga vacía.
- **`recordCommandResult(panel: Panel, body: CommandResult): Promise<void>`**, en `commands.ts`, con el cliente de administración:
  - si la orden es del mismo `panel_id`, `status = 'pending'` y `expires_at >= now()`, se marca `ok` o `error` con `detail` y `finished_at`;
  - si es del panel pero ya caducó, se marca `expired`;
  - si no existe o es de otro panel, lanza `DeviceApiError(404, "not_found", "Orden no encontrada")`.
- **`POST /api/device/v1/command-result`:** con `authenticateActiveDevice` y `readJsonBody(req, commandResultSchema)`; responde 204.
- **`panel-commands.ts`** (`server-only`), funciones de servidor para la Tarea 10:
  - **`requestLogsUploadAs(supabase, tenantId, installationId): Promise<{requestedAt: string; panels: {id: string; panel_code: string; online: boolean}[]}>`**
    - requiere `requireInstallationAccess(..., "tecnico")`, que también acepta admin;
    - con el cliente de administración, marca `logs_requested_at = now()` solo si está vacío o tiene más de 10 s. Si no se puede, lanza `HttpError(429, "Espera unos segundos antes de volver a actualizar.")`;
    - publica `{type: "upload_logs"}` con `publishToPanel` a los paneles activos y en línea, con `Promise.allSettled`;
    - devuelve todos los paneles activos, con su estado `online`.
  - **`logsUploadStatusAs(supabase, tenantId, installationId, since: string): Promise<{pending: string[]}>`:** devuelve los ids de los paneles activos y en línea cuyo `logs_uploaded_at` es nulo o anterior a `since`.
  - **`testOutputAs(supabase, tenantId, installationId, outputId): Promise<{commandId: string}>`:**
    - requiere acceso `"tecnico"`;
    - la salida debe ser de la instalación y su panel debe estar `active`. Si el panel no está `online`, lanza `HttpError(409, "Panel sin conexión")`;
    - si ya hay una orden `pending` sin caducar para esa salida, lanza `HttpError(409, "La salida ya se está probando")`;
    - inserta en `panel_commands` con el cliente de administración: `requested_by` = correo del usuario, `requested_by_user` = su id y `expires_at` = ahora + 10 s;
    - publica `{type: "test_output", command_id, output, requested_by, expires_at}` con `expires_at` en ISO UTC;
    - si la publicación falla, marca la orden como `error` con el detalle "No se pudo enviar la orden" y lanza `HttpError(502, …)`.
  - **`commandStatusAs(supabase, tenantId, installationId, commandId): Promise<{status: "pending"|"ok"|"error"|"expired"; detail: string|null}>`:** una orden `pending` cuyo `expires_at` ya pasó se informa como `expired`.

- [ ] **Paso 1: escribir las pruebas fallidas:**
  - **pgTAP:** RLS de `panel_commands` (un miembro lee, alguien de otro tenant no, `authenticated` no puede insertar) y las columnas nuevas.
  - **`command-result.test.ts`:**
    - un resultado `ok` marca la orden como `ok`;
    - un resultado de otro panel da 404;
    - un resultado tardío deja la orden en `expired`;
    - sin credencial, la respuesta es 401.
  - **`logs.test.ts`:** una lista vacía da 204 y actualiza `logs_uploaded_at`; un log con `source = 5` se guarda.
  - **`panel-commands.test.ts`** (con EMQX simulado con `vi.stubGlobal("fetch")`, como en `tests/mqtt.test.ts`):
    - `requestLogsUploadAs` publica solo a los paneles en línea;
    - una segunda petición antes de 10 s da 429;
    - `testOutputAs` con el panel fuera de línea da 409 "Panel sin conexión";
    - `testOutputAs` publica el payload correcto;
    - otra prueba de la misma salida mientras está pendiente da 409;
    - `commandStatusAs` informa `expired` cuando ya caducó;
    - un usuario de otro tenant recibe 403 o 404.
- [ ] **Paso 2:** correr las pruebas y confirmar que **fallan**.
- [ ] **Paso 3: implementar.**
- [ ] **Paso 4:** correr `npm test && npm run test:db && npx tsc --noEmit`. Esperado: todo pasa.

### Tarea 10: Nube — botones "Actualizar logs" y "Probar", y origen "Prueba"

**Archivos:**
- Crear: `cloud/src/components/logs/RefreshLogsButton.tsx` y `cloud/src/app/t/[tenant]/installations/[id]/logs/actions.ts`.
- Modificar:
  - las páginas `cloud/src/app/t/[tenant]/installations/[id]/logs/page.tsx` y `salidas/page.tsx`, y la acción `salidas/actions.ts`;
  - los componentes `cloud/src/components/access/OutputsManager.tsx` y `OutputForm.tsx`;
  - `cloud/src/lib/log-view.ts`.
- Pruebas: `cloud/tests/ui/logs.test.tsx`, `cloud/tests/ui/outputs.test.tsx` (si no existe, se crea) y `cloud/tests/ui/log-view.test.ts` (si existe).

**Interfaces:**
- **Acciones** (`"use server"`, con `runAction` y validando los argumentos con `z.tuple`):
  - en `logs/actions.ts`: `requestLogsUpload(tenantId, installationId)` y `logsUploadStatus(tenantId, installationId, since)`. Ninguna de las dos debe llamar a `refresh()`, porque la página se refresca desde el cliente. Si `runAction` siempre llama a `refresh()`, usa `runAction` con una opción nueva `{ refresh: false }`;
  - en `salidas/actions.ts`: `testOutput(tenantId, installationId, outputId)` y `commandStatus(tenantId, installationId, commandId)`, también sin `refresh()`.
- **`RefreshLogsButton({ onRequest, onStatus })`** (componente de cliente):
  1. al pulsar "Actualizar logs" llama a `onRequest` y muestra "Sincronizando…";
  2. cada 2 s llama a `onStatus(since)`; termina cuando `pending` queda vacío o a los 15 s;
  3. después llama a `router.refresh()`;
  4. muestra "Panel PNL-XXXX sin conexión" por cada panel fuera de línea y el error 429 con `Notices`.
- **`OutputForm`:**
  - suma la prop `onTest?: () => Promise<ActionResult<{commandId: string}>>` y el botón `type="button"` "Probar S1";
  - mientras espera dice "Probando…" y consulta `commandStatus` cada 1 s, hasta 8 s;
  - termina con uno de estos avisos: "Salida activada" (`ok`), el detalle del panel (`error`), o "El panel no respondió" (`expired` o se acabó el tiempo);
  - `OutputsManager` recibe las dos acciones y la página se las pasa ligadas al tenant y a la instalación.
- **`log-view.ts`:**
  - `SOURCES[5] = "Prueba"`;
  - `SOURCE_OPTIONS` suma 5;
  - `mediumLabel` con origen 5 devuelve `credential_label ?? "Prueba"`.

- [ ] **Paso 1: escribir las pruebas fallidas,** con temporizadores falsos y las acciones simuladas con `vi.fn`:
  - **`logs.test.tsx`:**
    - "Actualizar logs" llama a `onRequest`, consulta `onStatus` y llama a `refresh` cuando `pending` queda vacío;
    - a los 15 s se refresca aunque haya paneles pendientes;
    - un panel fuera de línea se muestra;
    - el 429 se muestra.
  - **`outputs.test.tsx`:**
    - "Probar S1" con resultado `ok` muestra "Salida activada";
    - si sigue `pending` a los 8 s, muestra "El panel no respondió";
    - si `testOutput` falla con 409, muestra "Panel sin conexión".
  - **`log-view`:** el origen 5 muestra "Prueba" y se puede elegir en el filtro.
- [ ] **Paso 2:** correr las pruebas y confirmar que **fallan**.
- [ ] **Paso 3: implementar,** usando las skills `frontend-design` y `vercel-react-best-practices`.
- [ ] **Paso 4:** correr `npm test && npm run lint && npx tsc --noEmit && npm run build`. Esperado: todo pasa.

### Tarea 11: Documentación y verificación de punta a punta

**Archivos:**
- Modificar:
  - `CLAUDE.md` (sección Estado, conteos de pruebas y socket del daemon);
  - `cloud/docs/despliegue.md` (migraciones nuevas para Access-Core-DEV y NTP en el panel);
  - `panel/README.md` (botón "Probar" y `DAEMON_SOCKET`);
  - `cloud/e2e/run_e2e.sh:195`, si cuenta `control_buttons` o lee `output_index`.

- [ ] **Paso 1:** actualizar los documentos. En `despliegue.md`, hay que explicar:
  - que las dos migraciones nuevas se aplican con `npx supabase db push`;
  - que EMQX no cambia;
  - que el panel se reinstala con el paquete nuevo por el `RuntimeDirectory`.
- [ ] **Paso 2:** correr la batería completa:
  - `cd cloud && npm test && npm run test:db && npm run lint && npx tsc --noEmit && npm run build`;
  - `cd panel/backend && .venv/bin/pytest`;
  - `cd panel/frontend && npm test && npm run lint && npm run build`;
  - `bash cloud/e2e/run_e2e.sh` (corrige lo que haya cambiado por los vínculos).

  Esperado: todo pasa.
