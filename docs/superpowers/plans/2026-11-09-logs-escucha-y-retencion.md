# Logs sin controles desconocidos, "Escuchar", borrado de logs y tabla compacta — Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development. Los pasos usan casillas (`- [ ]`).

**Objetivo:** dejar de registrar controles desconocidos, agregar "Escuchar" (panel local y nube), borrar logs desde la nube en nube y paneles, borrar automáticamente los logs con más de 30 días y compactar la tabla de logs de la nube.

**Arquitectura:**
- **Panel:**
  - el daemon deja de escribir el motivo 5 y purga cada día sus logs viejos;
  - un `RfListener` atiende la operación de socket `listen_rf`;
  - el agente atiende la orden MQTT `listen_rf` en un hilo propio y aplica el `logs_cleared_at` que trae el pull.
- **Nube:**
  - una migración agrega `listen_rf` y `rf_code` a `panel_commands`, `installations.logs_cleared_at`, `log_purges`, el disparador que filtra los logs al insertarlos y el trabajo diario de retención;
  - la interfaz agrega "Escuchar", "Borrar logs" y la tabla compacta.

**Stack:**
- Python ≥ 3.9 (daemon, FastAPI, agente) con pytest;
- Next.js 16 + Supabase (Vitest y pgTAP);
- Next.js del panel (Vitest).

**Spec:** `docs/superpowers/specs/2026-11-09-logs-escucha-y-retencion-design.md`. Este plan reemplaza a `docs/superpowers/plans/2026-10-30-borrar-logs.md`.

## Global Constraints

- **Git:** sin commits ni merges; todo queda sin confirmar en `develop`. Los pasos "Commit" de la plantilla **no se ejecutan**.
- **Idioma:** interfaz, errores y comentarios en español. Errores de la API local `{"detail": "..."}`; de la API de dispositivos `{code, message}`.
- **Panel:**
  - el esquema local **sigue en v7**, sin migración (los estados nuevos van en `sync_state`);
  - el protocolo UART no cambia;
  - el PIN nunca aparece en logs.
- **Nube:**
  - migración nueva con `cd cloud && npx supabase migration new logs_listen_retention`, aplicada solo en local (`npx supabase db reset` o `migration up`);
  - RLS en toda tabla nueva y `revoke` a `anon`;
  - las funciones privilegiadas van en `private`, o en `public` con `execute` solo para `service_role`.
- **Constantes:**
  - escucha: 10 s (`LISTEN_SECONDS = 10`);
  - vigencia de entrega de `listen_rf`: 5 s (`LISTEN_RF_TTL_MS = 5_000`);
  - la nube acepta el resultado hasta `expires_at + 15 s` (`LISTEN_RF_RESULT_GRACE_MS = 15_000`);
  - la página consulta cada 1 s, hasta 20 s;
  - retención: 30 días (`RETENTION_DAYS = 30`);
  - motivo 5: `REASON_UNKNOWN_CONTROL`;
  - trabajo cron `access-logs-retention` con horario `'0 9 * * *'` (03:00 en México).
- **Textos exactos:**
  - "Escuchar" y, mientras escucha, "Escuchando…";
  - "No se recibió ningún control.";
  - "Ya hay una escucha en curso.";
  - "Este código ya pertenece a {descripción}" (sin descripción: "Este código ya pertenece a otro control");
  - "El panel no respondió.";
  - "Panel sin conexión";
  - "El panel no está activo.";
  - "Panel que escucha";
  - "Borrar logs";
  - "Escribe el nombre de la instalación para confirmar.";
  - "El nombre no coincide con la instalación.";
  - "Se borraron N logs de la nube. Los paneles borran los suyos al sincronizar.".
- **"Ya pertenece":** si el código pertenece al **mismo** control que se edita, se escribe en el campo sin aviso; si pertenece a otro, se avisa y no se escribe.

## Review Focus

1. **Dos peticiones al socket mientras hay una escucha:** "Probar", la apertura remota o una segunda escucha no deben esperar los 10 s. Prueba en la Tarea 2: `test_output` responde mientras `listen_rf` está bloqueado.
2. **Orden `listen_rf` en el agente mientras llega una `remote_open`:** la apertura no espera a que termine la escucha. Prueba en la Tarea 4.
3. **Borrado en la nube mientras un panel sube logs viejos:** el disparador descarta las filas con `ts <= logs_cleared_at`. Prueba pgTAP en la Tarea 5: un insert posterior al borrado con `ts` anterior no queda guardado.
4. **Reloj de la placa sin NTP (año < 2026):** la purga de 30 días no borra nada. Prueba en la Tarea 1.
5. **Resultado de `listen_rf` que llega entre `expires_at` y `expires_at + 15 s`:** se acepta (la escucha empieza al recibir la orden). Prueba en la Tarea 6.

---

### Task 1: Panel: sin logs de motivo 5 y purga de 30 días

**Files:**
- Modify: `panel/backend/acceso/access.py` (`handle_event`)
- Modify: `panel/backend/acceso/logs.py`
- Modify: `panel/backend/acceso/daemon.py` (`run_daemon`)
- Test: `panel/backend/tests/test_access.py`, `panel/backend/tests/test_logs.py`, `panel/backend/tests/test_daemon.py`

**Interfaces:**
- Produces:
  - `logs.RETENTION_DAYS = 30`;
  - `logs.purge_old_logs(conn, now: float, days: int = RETENTION_DAYS) -> int`: borra `access_logs` con `timestamp < now - days*86400` y devuelve cuántos. Si `datetime.fromtimestamp(now).year < 2026`, no borra y devuelve 0;
  - `logs.delete_logs_until(conn, until_ts: int) -> int`: borra `timestamp <= until_ts` y devuelve cuántos. Lo usa la Tarea 4.
- `handle_event` devuelve `AccessOutcome(False, REASON_UNKNOWN_CONTROL, None, None)` (sin `log_id`) para un RF desconocido.

- [ ] **Step 1: Pruebas que fallan.**
  - `test_unknown_rf_is_not_logged`: con un código RF desconocido, `handle_event` no inserta filas y `outcome.log_id is None`.
  - `test_unknown_card_still_logged`: una tarjeta desconocida se sigue registrando (motivo 1).
  - `test_purge_old_logs_deletes_older_than_30_days`: con logs de hace 31 días y de hace 29 días, devuelve 1 y se queda el de 29.
  - `test_purge_old_logs_skips_without_clock`: con `now` en 1970, devuelve 0 y no borra.
  - `test_delete_logs_until_inclusive`: borra `timestamp <= until_ts`.
  - En `test_daemon.py`, `test_daemon_purges_on_start`: `run_daemon` con un `purge` inyectado lo llama al arrancar.
- [ ] **Step 2: Ejecutar.** `cd panel/backend && .venv/bin/pytest tests/test_access.py tests/test_logs.py tests/test_daemon.py -q`. Esperado: FALLAN.
- [ ] **Step 3: Implementar.**
  - En `handle_event`, rama RF: si `decision.reason == REASON_UNKNOWN_CONTROL`, devuelve sin `append_log`.
  - En `run_daemon`, un hilo daemon `log-retention`, con su propia conexión, llama a `purge_old_logs(conn, time.time())` al arrancar y luego cada 24 h. Se detiene con `stop`, usando `stop.wait(86400)`. Registra en el journal cuántos borró, solo si borró alguno.
  - `run_daemon` acepta `purge_interval_s: float = 86400` para las pruebas.
- [ ] **Step 4: Ejecutar** el mismo comando. Esperado: PASAN. Después corre `.venv/bin/pytest -q` completo.

### Task 2: Panel: `listen_rf` en el daemon y `POST /api/controls/listen`

**Files:**
- Create: `panel/backend/acceso/rf_listen.py`
- Modify:
  - `panel/backend/acceso/access.py` (`handle_event`, parámetro `rf_listener`);
  - `panel/backend/acceso/daemon.py`;
  - `panel/backend/acceso/daemon_socket.py`;
  - `panel/backend/acceso/web/routes/controls.py`.
- Test: `panel/backend/tests/test_rf_listen.py`, `tests/test_daemon_socket.py`, `tests/test_web_controls.py` (o el archivo de pruebas de rutas de controles que ya exista)

**Interfaces:**
- Produces:
  - `rf_listen.LISTEN_SECONDS = 10`;
  - `rf_listen.LISTEN_CLIENT_TIMEOUT_S = 13.0`;
  - `class RfListener`:
    - `offer(code: int) -> bool`: entrega el código a la escucha activa, si la hay;
    - `handle(request: dict) -> dict`, para `{"op": "listen_rf"}`;
    - constructor `RfListener(db_path, clock=time.monotonic)`.
  - Respuestas del socket:
    - recibido: `{"ok": True, "code": int, "control": {"control_id": int, "description": str|None} | None}`;
    - sin control: `{"ok": False, "detail": "No se recibió ningún control."}`;
    - ocupado: `{"ok": False, "detail": "Ya hay una escucha en curso."}`.
  - `handle_event(..., rf_listener: Optional[RfListener] = None)`: en la rama RF llama a `rf_listener.offer(event.code)` **antes** de autorizar. Un código conocido sigue su flujo normal: abre y registra.
  - `request_daemon(path, payload, timeout)` no cambia. La web llama con `timeout=LISTEN_CLIENT_TIMEOUT_S`.
  - `POST /api/controls/listen` responde:
    - 200 `{"code": int|null, "control": {...}|null}`, con `code: null` cuando no se recibió ningún control;
    - 409 `{"detail": "Ya hay una escucha en curso."}`;
    - 503 `{"detail": "El daemon no responde"}`.

- [ ] **Step 1: Pruebas que fallan.**
  - `test_listen_returns_first_code`: un hilo llama a `handle({"op":"listen_rf"})` y otro a `offer(123)`. La respuesta es `ok` con `code == 123` y `control is None`, y un segundo `offer` devuelve False.
  - `test_listen_reports_known_control`: con `control_buttons.rf_code = 555`, la respuesta trae su `control_id` y su `description`.
  - `test_listen_times_out`: con un reloj falso o `LISTEN_SECONDS` parcheado a 0.1, responde "No se recibió ningún control.".
  - `test_listen_busy`: una segunda escucha simultánea responde "Ya hay una escucha en curso.".
  - `test_known_rf_opens_and_feeds_listener`: con un listener activo, `handle_event` con un RF conocido abre (envía la trama) y entrega el código.
  - `test_socket_serves_concurrently`: en `test_daemon_socket.py`, con un handler que bloquea en `listen_rf`, otra petición se responde en menos de 1 s.
  - Rutas:
    - `test_listen_route_ok`, con `app.state.daemon_request` falso;
    - `test_listen_route_no_code`, que espera `code: null`;
    - `test_listen_route_busy_409`;
    - `test_listen_route_daemon_down_503`;
    - verifica también que la web pasa `timeout=13.0`.
- [ ] **Step 2: Ejecutar.** `.venv/bin/pytest tests/test_rf_listen.py tests/test_daemon_socket.py -q` y las pruebas de rutas. Esperado: FALLAN.
- [ ] **Step 3: Implementar.**
  - `RfListener` usa un `threading.Condition`: una sola escucha activa y espera de hasta `LISTEN_SECONDS`.
  - **Socket:** `DaemonSocketServer` atiende cada conexión en su propio hilo daemon, con un máximo de `MAX_CONNECTIONS = 4` (un `BoundedSemaphore` con `acquire(blocking=False)`). Sin hueco, responde `{"ok": False, "detail": "El daemon está ocupado."}`. El plazo de lectura de la petición sigue en `CONNECTION_TIMEOUT_S`.
  - **Daemon:** un despachador por `op` (`listen_rf` va a `RfListener.handle`; lo demás a `OutputTester.handle`) y `_serve` pasa `rf_listener` a `handle_event`.
- [ ] **Step 4: Ejecutar** las mismas pruebas y luego `.venv/bin/pytest -q`. Esperado: PASAN.

### Task 3: Web local: botón "Escuchar" en la ficha del control

**Files:**
- Modify: `panel/frontend/src/components/ControlForm.tsx`, `panel/frontend/src/lib/api.ts` (o el cliente de API existente), `panel/frontend/src/lib/types.ts`
- Test: `panel/frontend/src/components/ControlForm.test.tsx` (crear o ampliar)

**Interfaces:**
- Consumes: `POST /api/controls/listen` (Tarea 2).
- Produces:
  - `listenRf(): Promise<{ code: number | null; control: { control_id: number; description: string | null } | null }>` en el cliente de API;
  - `ControlForm` recibe la prop `onListen?: () => Promise<...>`, que por omisión usa `listenRf`.

- [ ] **Step 1: Pruebas que fallan.**
  - "Escuchar" deshabilita el botón y muestra "Escuchando…". Con `{code: 4321, control: null}`, escribe `4321` en ese botón.
  - Con `code: null`, muestra "No se recibió ningún control.".
  - Con un control **distinto** del que se edita, muestra "Este código ya pertenece a Portón" y no cambia el campo.
  - Con el **mismo** control, escribe el código sin aviso.
  - Con un error de la API, muestra su `detail`.
- [ ] **Step 2: Ejecutar.** `cd panel/frontend && npm test -- ControlForm`. Esperado: FALLAN.
- [ ] **Step 3: Implementar.** Un botón "Escuchar" por fila, junto al código. Solo una escucha a la vez en el formulario: los demás botones "Escuchar" quedan deshabilitados mientras dura. El mensaje se muestra en la fila con `aria-live="polite"`.
- [ ] **Step 4: Ejecutar** `npm test`, `npm run lint` y `npm run build`. Esperado: PASAN. Después regenera los estáticos del backend con el mecanismo que use el proyecto (ver `panel/README.md`).

### Task 4: Agente: orden `listen_rf` y `logs_cleared_at` en el pull

**Files:**
- Modify: `panel/backend/acceso/cloud/commands.py`, `runner.py`, `api.py`, `sync.py`, `mqtt_link.py` (si filtra los tipos de mensaje)
- Test: `panel/backend/tests/cloud/test_commands.py`, `test_runner.py`, `test_sync.py` (los archivos existentes de esas piezas)

**Interfaces:**
- Consumes:
  - socket `listen_rf` y `LISTEN_CLIENT_TIMEOUT_S` (Tarea 2);
  - `logs.delete_logs_until` (Tarea 1).
- Produces:
  - **Mensaje MQTT** `{"type": "listen_rf", "command_id": uuid, "expires_at": ISO}`: sin `output` ni `requested_by`;
  - `CloudApi.post_command_result(command_id, ok, detail, reason=None, rf_code=None)`: `rf_code` solo se envía si no es None;
  - `post_result` del worker con la firma `(command_id, ok, detail, reason, rf_code)`;
  - **Respuesta a la nube:**
    - recibido: `ok=True`, `rf_code=code`, `detail=None`;
    - si no: `ok=False` y el `detail` del daemon;
  - **Pull:** la respuesta de `GET /changes` puede traer `logs_cleared_at` (ISO o null). Si es mayor que `sync_state['logs_cleared_at']` (época en segundos, como texto), el agente llama a `delete_logs_until(conn, epoch)` y guarda la marca en la misma transacción que el cursor.

- [ ] **Step 1: Pruebas que fallan.**
  - `test_listen_order_runs_in_own_thread`: mientras un `listen_rf` espera en un daemon falso bloqueado, una `remote_open` enviada después se atiende y se informa primero.
  - `test_listen_order_posts_rf_code`.
  - `test_listen_order_expired_is_dropped`.
  - `test_listen_order_uses_long_timeout`: el daemon falso recibe `timeout=13.0`.
  - `test_pull_applies_logs_cleared_at`: borra los logs con `timestamp <=` la marca, conserva los posteriores y guarda la marca.
  - `test_pull_same_logs_cleared_at_not_reapplied`: con la misma marca, un log nuevo anterior a ella **no** se vuelve a borrar.
  - `test_pull_without_logs_cleared_at`: no borra nada.
- [ ] **Step 2: Ejecutar.** `.venv/bin/pytest tests/cloud -q`. Esperado: FALLAN.
- [ ] **Step 3: Implementar.**
  - **Workers:** `CommandWorker` recibe `kinds` y `timeout`. El runner crea dos workers: `cloud-commands` (`test_output`, `remote_open`) y `cloud-listen` (`listen_rf`, `timeout=LISTEN_CLIENT_TIMEOUT_S`). `_command` enruta por `type`.
  - **Arranque y parada:** los dos workers comparten la deduplicación por `command_id` dentro de cada uno, y arrancan y se detienen juntos (`_ensure_worker` y `_stop_worker`).
  - **Petición al daemon:** `_parse` acepta `listen_rf` sin `output` ni `requested_by`. `_request` envía `{"op": "listen_rf"}`.
- [ ] **Step 4: Ejecutar** `.venv/bin/pytest -q` completo. Esperado: PASAN.

### Task 5: Nube: migración (escucha, borrado y retención)

**Files:**
- Create: `cloud/supabase/migrations/<ts>_logs_listen_retention.sql` (con `npx supabase migration new logs_listen_retention`)
- Create: `cloud/supabase/tests/logs_listen_retention.test.sql` (pgTAP)

**Interfaces:**
- Produces:
  - **`panel_commands`:**
    - `kind` admite `'listen_rf'`;
    - `output_index` pasa a ser nulo y se agrega `check ((kind = 'listen_rf') = (output_index is null))`;
    - columna `rf_code bigint` (`check (rf_code between 0 and 4294967295)`) con `grant select (rf_code)` a `authenticated`;
    - índice único `panel_commands_pending_listen_key on (panel_id) where status = 'pending' and kind = 'listen_rf'`.
  - **`installations.logs_cleared_at timestamptz`** (nulo), con `grant select` de la columna a `authenticated`.
  - **`public.log_purges`:**
    - columnas `id uuid pk`, `tenant_id`, `installation_id` (FK en cascada), `purged_at timestamptz default now()`, `purged_by uuid references auth.users on delete set null`, `purged_by_label text`, `deleted_count int not null`;
    - RLS `select` para miembros (`private.is_member(tenant_id)`);
    - sin escritura para `authenticated`; índices en las FK.
  - **`public.purge_installation_logs(p_installation uuid, p_user uuid, p_label text) returns int`:**
    - `security definer` y `set search_path = ''`;
    - en una transacción: borra `access_logs` de la instalación, pone `logs_cleared_at = now()`, inserta en `log_purges` y devuelve el conteo;
    - `revoke execute` de `public`, `anon` y `authenticated`; `grant` a `service_role`.
  - **Disparador `before insert` en `access_logs`** (`private.filter_access_log()`): devuelve `null` (descarta la fila) si `new.reason = 5`, si `new.ts <= logs_cleared_at` de su instalación (leído con `for share`) o si `new.ts < now() - interval '30 days'`.
  - **Índice** `access_logs_ts_idx on public.access_logs (ts)`.
  - **`cron.schedule('access-logs-retention', '0 9 * * *', $$delete from public.access_logs where ts < now() - interval '30 days'$$)`**.

- [ ] **Step 1: pgTAP que falla.**
  - Un log con `reason = 5` no se guarda; uno con `reason = 1`, sí.
  - Un log con `ts` de hace 31 días no se guarda.
  - **Borrado:** `purge_installation_logs` borra solo esa instalación, devuelve el conteo, fija `logs_cleared_at` e inserta en `log_purges`.
  - **Después del borrado:** un insert con `ts` anterior a la marca no se guarda; uno posterior, sí.
  - **Permisos:** `authenticated` no puede ejecutar `purge_installation_logs`. Un miembro lee `log_purges` de su tenant y no los de otro.
  - **Escucha:**
    - dos `listen_rf` pendientes del mismo panel violan el índice;
    - `listen_rf` con `output_index` no nulo viola el check;
    - `test_output` sin `output_index` viola el check.
  - Existe el trabajo `access-logs-retention`.
- [ ] **Step 2: Ejecutar.** `cd cloud && npx supabase db reset && npm run test:db`. Esperado: las nuevas FALLAN.
- [ ] **Step 3: Escribir la migración.** Revisa los advisors (`get_advisors` local) y corrige lo que señalen.
- [ ] **Step 4: Ejecutar** `npx supabase db reset && npm run test:db`. Esperado: PASAN todas. Regenera los tipos si el proyecto los versiona.

### Task 6: Nube: API de dispositivos (resultado de `listen_rf` y `logs_cleared_at`)

**Files:**
- Modify:
  - `cloud/src/lib/device/contract.ts` (`commandResultSchema` y el tipo de la respuesta del pull);
  - `cloud/src/lib/device/commands.ts` (`recordCommandResult`);
  - `cloud/src/lib/device/changes.ts` (`listChanges`);
  - el comentario de `cloud/src/app/api/device/v1/command-result/route.ts`.
- Test: las pruebas existentes de esas piezas (`*.test.ts` junto a ellas o en `cloud/tests`)

**Interfaces:**
- Consumes: las columnas de la Tarea 5.
- Produces:
  - `commandResultSchema.rf_code`: entero de 0 a 4294967295, nulo u opcional;
  - en `recordCommandResult`, para `kind = 'listen_rf'` el resultado se acepta si `now <= expires_at + LISTEN_RF_RESULT_GRACE_MS`, y se guarda `rf_code`;
  - `LISTEN_RF_RESULT_GRACE_MS = 15_000`, exportado desde `cloud/src/lib/device/commands.ts`;
  - `listChanges` agrega `logs_cleared_at: string | null` (ISO de `installations.logs_cleared_at`) a cada página.
- Nota: el ingreso de logs (`storeLogs`) **no cambia**; el disparador de la Tarea 5 filtra.

- [ ] **Step 1: Pruebas que fallan.**
  - Un `listen_rf` con un resultado 10 s después de `expires_at` queda `ok` con `rf_code`; uno 16 s después queda `expired`.
  - `test_output` sigue venciendo en `expires_at`.
  - `rf_code` fuera de rango da 400.
  - Una página de `listChanges` trae `logs_cleared_at`.
  - `storeLogs` con un log de motivo 5 responde `accepted` con el total y no guarda la fila.
- [ ] **Step 2: Ejecutar.** `cd cloud && npm test -- device`. Esperado: FALLAN.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar** `npm test`. Esperado: PASA.

### Task 7: Nube: lógica y acciones de "Escuchar" y "Borrar logs"

**Files:**
- Modify: `cloud/src/lib/panel-commands.ts`
- Create: `cloud/src/lib/log-purge.ts`
- Modify:
  - `cloud/src/app/t/[tenant]/installations/[id]/controles/actions.ts`;
  - `cloud/src/app/t/[tenant]/installations/[id]/logs/actions.ts`.
- Test: `cloud/src/lib/panel-commands.test.ts` y `cloud/src/lib/log-purge.test.ts` (o la ubicación de pruebas existente)

**Interfaces:**
- Consumes:
  - las columnas y la función de la Tarea 5;
  - `LISTEN_RF_RESULT_GRACE_MS` (Tarea 6);
  - `publishToPanel` y `PublicacionNoEntregada`.
- Produces:
  - **`listenRfAs(supabase, tenantId, installationId, panelId): Promise<{ commandId: string }>`:**
    - rol `tecnico`;
    - errores: panel ajeno o inexistente 404 "El panel no existe."; no activo 409 "El panel no está activo."; sin conexión 409 "Panel sin conexión";
    - antes de insertar, marca `expired` los `listen_rf` pendientes con `expires_at + 15 s < now`;
    - índice único violado: 409 "Ya hay una escucha en curso.";
    - publica `{type:"listen_rf", command_id, expires_at}` con `expires_at = now + LISTEN_RF_TTL_MS`;
    - si el publish falla (cualquier error), la orden queda `error` y responde 502 "No se pudo enviar la orden al panel. Intenta de nuevo.".
  - **`listenRfStatusAs(supabase, tenantId, installationId, commandId)`**, que devuelve `Promise<{ status: "pending" | "received" | "error" | "timeout"; code: number | null; control: { id: string; description: string | null } | null; detail: string | null }>`:
    - `ok` → `received`, con el control **vivo** de la instalación cuyo botón tiene ese `rf_code` (o null);
    - `error` → `error`, con el `detail` del panel;
    - pendiente con `expires_at + 15 s` vencido, o `expired` → `timeout` con "El panel no respondió.".
  - **`purgeInstallationLogsAs(supabase, tenantId, installationId, confirmName: string): Promise<{ deleted: number }>`:**
    - rol `admin`;
    - si `confirmName.trim() !== nombre de la instalación`, responde 400 "El nombre no coincide con la instalación.";
    - llama a `purge_installation_logs` con el cliente admin, `p_user = userId` y `p_label = email || userId`;
    - después publica `{type:"sync"}` (sin `revision`) a cada panel activo; un publish que falla solo se registra en el log.
  - **Server actions** (`runAction`, igual que `testOutput` y `commandStatus`; las consultas con `refresh: false`):
    - `listenRf(tenantId, installationId, panelId)` y `listenRfStatus(tenantId, installationId, commandId)` en `controles/actions.ts`;
    - `purgeLogs(tenantId, installationId, confirmName)` en `logs/actions.ts`, que sí refresca.

- [ ] **Step 1: Pruebas que fallan** (contra el Supabase local, como las existentes de `testOutputAs`).
  - Escucha:
    - técnico OK;
    - panel sin conexión 409;
    - segunda escucha pendiente 409 "Ya hay una escucha en curso.";
    - publish fallido 502 y orden `error`;
    - el estado `received` trae el control dueño del código;
    - un pendiente vencido devuelve `timeout` con "El panel no respondió.".
  - Borrado:
    - técnico 403;
    - nombre distinto 400;
    - admin OK, con conteo, `log_purges` y publish de `{type:"sync"}` a los paneles activos;
    - un publish fallido no rompe el borrado.
- [ ] **Step 2: Ejecutar.** `cd cloud && npm test -- panel-commands log-purge`. Esperado: FALLAN.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Ejecutar** `npm test` y `npx tsc --noEmit`. Esperado: PASAN.

### Task 8: Nube: interfaz ("Escuchar", "Borrar logs" y tabla compacta)

**Files:**
- Modify:
  - `cloud/src/components/access/ControlForm.tsx`;
  - `cloud/src/components/access/ControlsManager.tsx`;
  - `cloud/src/app/t/[tenant]/installations/[id]/controles/page.tsx`;
  - `cloud/src/components/logs/LogTable.tsx`;
  - `cloud/src/lib/log-view.ts`;
  - `cloud/src/app/t/[tenant]/installations/[id]/logs/page.tsx`.
- Create: `cloud/src/components/logs/PurgeLogsButton.tsx`
- Test: los `*.test.tsx` de esos componentes

**Interfaces:**
- Consumes: las acciones de la Tarea 7.
- Produces:
  - `ControlForm` recibe las props opcionales `onListen?: (panelId: string) => Promise<ActionResult<{ commandId: string }>>` y `onListenStatus?: (commandId: string) => Promise<ActionResult<...>>`;
  - `formatDateTimeShort(iso: string): string` en `log-view.ts`, en formato `dd/mm/aa hh:mm:ss` y hora de México.

- [ ] **Step 1: Pruebas que fallan.**
  - **ControlForm:**
    - con 2 paneles **activos** aparece el selector "Panel que escucha"; con 1, no. Solo se ofrecen paneles activos, así que `ControlPanel` gana el campo `active: boolean`, que llena la página;
    - "Escuchar" muestra "Escuchando…" y consulta el estado (temporizadores falsos, cada 1 s);
    - con `received`, escribe el código;
    - con el control de **otro** registro, muestra "Este código ya pertenece a …" y no escribe;
    - con `error`, muestra el `detail`;
    - si a los 20 s sigue pendiente, muestra "El panel no respondió.".
  - **PurgeLogsButton:**
    - el botón de confirmar queda deshabilitado hasta que el texto coincide con el nombre;
    - al confirmar llama a `purgeLogs` y muestra "Se borraron N logs de la nube. Los paneles borran los suyos al sincronizar.".
  - **Página de logs:** "Borrar logs" solo se muestra si `acceso.role === "admin"`.
  - **LogTable:**
    - la tabla usa `text-xs`;
    - la fecha sale en formato corto (`09/11/26 08:14:32`);
    - las filas pares llevan el fondo alterno.
- [ ] **Step 2: Ejecutar.** `cd cloud && npm test -- ControlForm PurgeLogs LogTable`. Esperado: FALLAN.
- [ ] **Step 3: Implementar.**
  - **Tabla (opción A):** `text-xs`, celdas `px-2.5 py-1.5`, `whitespace-nowrap` en todas salvo Titular (`min-w-36`, puede cortar), filas pares con `even:bg-paper/60` y el contenedor con `overflow-x-auto`.
  - **Confirmación del borrado:** un `<dialog>` nativo con el campo del nombre y un botón de peligro (`btn-danger` o la clase de peligro existente).
  - **"Escuchar":** un botón por fila junto al código. El selector "Panel que escucha" va sobre la tabla de botones cuando hay más de un panel. Se usan las skills `frontend-design` y `vercel-react-best-practices`.
- [ ] **Step 4: Ejecutar** `npm test`, `npm run lint`, `npm run build` y `npx tsc --noEmit`. Esperado: PASAN.

### Task 9: Documentación y verificación final

**Files:**
- Modify:
  - `CLAUDE.md`: estado, motivos, migraciones pendientes (`logs_listen_retention`), "Borrar logs" ya no está en pausa y pendientes de hardware ("probar Escuchar con la placa");
  - `panel/README.md`: `listen_rf`, la purga de 30 días, que el motivo 5 ya no se registra y `POST /api/controls/listen`;
  - `cloud/docs/despliegue.md`: la migración nueva, el orden de despliegue y que los paneles anteriores no escuchan ni borran por orden de la nube;
  - `cloud/docs/api.md`: los logs se guardan 30 días y no hay motivo 5 nuevo.

- [ ] **Step 1: Actualizar los documentos.**
- [ ] **Step 2: Verificación completa.** Todo debe pasar:
  - `cd panel/backend && .venv/bin/pytest -q`;
  - `cd panel/frontend && npm test && npm run lint && npm run build`;
  - `cd cloud && npm test && npm run test:db && npm run lint && npm run build && npx tsc --noEmit`;
  - `bash cloud/e2e/run_e2e.sh`.
