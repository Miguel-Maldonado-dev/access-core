# Apertura remota (etapa 3) — Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans. Los pasos usan casillas (`- [ ]`).

**Objetivo:** que una app externa abra una salida a nombre de un titular con `POST /api/v1/installations/{installationId}/outputs/{outputId}/open`. El panel valida el permiso "Permitir apertura remota" del titular para esa salida, el día y la hora, y la API responde abierto, denegado (con motivo), fallido o sin respuesta.

**Arquitectura:**
- Se reutiliza el canal de "Probar": orden en `panel_commands`, MQTT `acc/<code>/cmd`, el `CommandWorker` del agente, el socket del daemon y el resultado por `POST /api/device/v1/command-result`.
- El daemon suma la operación `remote_open`, que autoriza con `permission_allows` y el método nuevo `METHOD_REMOTE`.
- El permiso gana la columna `allow_remote` en el panel (esquema v7) y en la nube (`profile_panel_rules`).

**Stack:**
- panel: Python ≥ 3.9 y SQLite, frontend Next.js y Vitest;
- nube: Next.js 16, Supabase (pgTAP) y Vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-plataforma-nube-design.md` §9, incluidos los "Ajustes al implementar (2026-11-02)", que son la autoridad. Se apoya en el canal de "Probar" de `docs/superpowers/specs/2026-10-30-controles-por-panel-logs-y-prueba-de-salidas-design.md` §5 y en la API de `docs/superpowers/plans/2026-11-02-api-publica-etapa2a.md`.

## Global Constraints

- **Git:** sin commits ni merges; todo queda sin confirmar en `develop`. Todo el texto va en español.
- **Panel:**
  - Python ≥ 3.9, sin `X | Y`, con comentarios `# type:`;
  - **esquema local v7** = v6 + `permissions.allow_remote INTEGER NOT NULL DEFAULT 0 CHECK(allow_remote IN (0,1))`;
  - la migración conserva sus garantías actuales: bloqueo de archivo, una transacción y respaldo 0600 con máximo 3 copias.
- **Constantes del panel:**
  - `SOURCE_REMOTE = 4` ("Remota");
  - `REASON_UNKNOWN_HOLDER = 11` ("Titular desconocido");
  - `METHOD_REMOTE = "remote"`.
- **Log de una apertura remota:**
  - `source = 4`, la copia del titular (`HolderRef`) y `output_id`;
  - `credential_label` = `requested_by` tal cual llega, de 1 a 120 caracteres;
  - `allowed` y `reason` según la decisión.
- **Respuesta del daemon a `remote_open`:** `{"ok": bool, "reason": int, "detail": "<texto en español>"}`. Los textos son:
  - `ok`: "Salida abierta";
  - motivo 11: "Titular desconocido";
  - motivo 2: "La salida no existe o está deshabilitada";
  - motivo 3: "Sin permiso de apertura remota";
  - motivo 4: "No se pudo enviar la orden al relevador.";
  - ocupado: "La salida ya está en uso" (`reason` 0, `ok` false).
- **Nube:**
  - `panel_commands.kind in ('test_output','remote_open')`;
  - se suman `holder_id uuid` (obligatorio si `kind = 'remote_open'`) y `reason int`.
- **API:**
  - cuerpo `{holder_id: uuid, requested_by: string 1..120}`;
  - la orden vence en **10 s** y la API espera la confirmación hasta **8 s**;
  - responde 200 `{data: {command_id, status: "opened"|"denied"|"failed"|"timeout", reason: int|null, detail: string|null}}`;
  - si el panel está fuera de línea o no activo, responde 409 "Panel sin conexión"; si ya hay una orden pendiente en esa salida, 409 "La salida ya tiene una orden en curso.";
  - un titular de otra instalación da 400 "El titular no existe.";
  - admite `Idempotency-Key`.
- **Compatibilidad:** el panel toma `allow_remote` faltante en un permiso que viene de la nube como `false`, y la nube acepta un push de permisos sin `allow_remote` (opcional, `false` por omisión). La nube **siempre** proyecta el campo.
- **Pruebas:**
  - panel: `cd panel/backend && .venv/bin/pytest`; `cd panel/frontend && npm test && npm run lint && npm run build`;
  - nube: `cd cloud && npm test && npm run test:db && npm run lint && npm run build && npx tsc --noEmit`.
- **Migraciones de Supabase:** se crean con `npx supabase migration new <nombre>` y solo se aplican en local. El dueño las aplica en remoto con `--remote`.

## Review Focus

1. **Titular sin permiso remoto**, aunque tenga tarjeta o RF en esa salida. El daemon rechaza con motivo 3, el relevador no se activa y queda un log `allowed = 0` con origen 4 (Tarea 2).
2. **Horario o día fuera de la ventana del permiso**, incluida una ventana que cruza la medianoche. Rechaza con motivo 3 (Tarea 2).
3. **Orden repetida o caducada** de `remote_open`. No se abre (el agente reutiliza la deduplicación de `test_output`) y no se escribe log (Tarea 3).
4. **Panel viejo (v6) con nube nueva, y panel nuevo (v7) con nube vieja.** La sincronización de permisos no falla en ninguno de los dos sentidos (Tareas 3 y 4).
5. **Salida deshabilitada.** "Probar" la sigue activando, pero una apertura remota la rechaza con motivo 2 (Tarea 2).

---

### Tarea 1: Esquema local v7 y permiso "Permitir apertura remota" en el panel

**Archivos:**
- Modificar:
  - backend: `panel/backend/acceso/constants.py`, `schema.py` (columna nueva y `DEFAULT_PERMISSION`), `migrate.py` (`_convert_v6`, encadenar v5 → v6 → v7, `_detect_version` acepta 6), `store/permissions.py`, `web/schemas.py` y `web/routes/permissions.py`;
  - frontend: `panel/frontend/src/components/PermissionForm.tsx`, `app/(panel)/permisos/page.tsx`, `lib/types.ts`, `lib/format.ts` (`SOURCES[4] = "Remota"`, `REASONS[11]`) y `components/LogFilters.tsx` (opción 4).
- Pruebas: `tests/test_migrate.py`, `tests/test_schema_v6.py` (se renombra a `test_schema_v7.py`), `tests/test_api_permissions.py`, `tests/helpers.py` (`set_permission(..., allow_remote=0)`) y las del frontend.

**Interfaces:**
- **Migración v6 → v7:** `_convert_v6(conn)` hace `ALTER TABLE permissions ADD COLUMN allow_remote …` y fija `user_version = 7`. `_convert_v5` deja `user_version = 6`.
- **API local:** `PermissionBody.allow_remote: StrictBool = False` y `PermissionCreate.allow_remote: StrictBool`, obligatorio. En el `PUT`, si el campo no viene se conserva el valor (el mismo `COALESCE` que usa `allow_rf`).
- **`DEFAULT_PERMISSION`:** `allow_remote = 0` **[decisión de Claude]**. La apertura remota se habilita a propósito.
- **Interfaz local:**
  - casilla "Permitir apertura remota" debajo de "Permitir control RF", con el texto de ayuda "La app del fraccionamiento puede abrir estas salidas a nombre del titular.";
  - columna "Remota" en la tabla de permisos, con "Sí" o "—".

- [ ] **Paso 1: escribir las pruebas.**
  - `test_schema_version_is_7`.
  - Migración:
    - una base v6 migra a v7 con `allow_remote = 0` en los permisos que ya existían, y con los datos, el `uuid` y la bandeja intactos;
    - las pruebas de "esquema idéntico" (migrado contra nuevo) quedan en v7;
    - una base v5 migra hasta v7.
  - API: crear con `allow_remote: true`; un `PUT` sin el campo conserva el valor; `allow_remote: "si"` da 422.
  - Frontend:
    - el formulario envía `allow_remote`;
    - la tabla muestra la columna;
    - `sourceLabel(4)` devuelve "Remota" y `REASONS[11]` es "Titular desconocido";
    - `LogFilters` ofrece "Remota".
- [ ] **Paso 2:** confirmar que fallan.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `cd panel/backend && .venv/bin/pytest` y `cd panel/frontend && npm test && npm run lint && npm run build`.

### Tarea 2: Operación `remote_open` en el daemon

**Archivos:**
- Modificar: `panel/backend/acceso/access.py` (`METHOD_REMOTE` en `permission_allows`), `panel/backend/acceso/output_test.py` (despacho por `op`) y `panel/backend/acceso/constants.py`, si falta algo de la Tarea 1.
- Pruebas: `panel/backend/tests/test_output_test.py` y `tests/test_access.py`.

**Interfaces:**
- **`permission_allows(conn, holder_id, output_id, METHOD_REMOTE, None, now)`:** acepta el permiso si `allow_remote == 1`, con la misma ventana de día y hora y la misma `output_mask`.
- **`OutputTester.handle(request)`** despacha por `request["op"]`:
  - `"test_output"`: igual que hoy;
  - `"remote_open"`, con el cuerpo `{"op","output","holder_uuid","requested_by"}`:
    - `holder_uuid` debe ser un uuid canónico en minúsculas;
    - `output` es un entero de 0 a 3 (no `bool`);
    - `requested_by` sigue las mismas reglas que en "Probar".
- **Orden de `remote_open`:**
  1. validar la petición; si falla, devolver `INVALID_REQUEST`;
  2. abrir la conexión;
  3. buscar el titular por `holders.uuid`; si no existe, motivo 11;
  4. leer `outputs` con `enabled = 1`; si falta, motivo 2;
  5. comprobar `permission_allows(..., METHOD_REMOTE, ...)` con `now` local (como en `access.py`); si no pasa, motivo 3;
  6. con el candado, revisar `busy_until`: si la salida está ocupada, `{"ok": false, "reason": 0, "detail": "La salida ya está en uso"}`;
  7. `relay.send` con la duración configurada; si da `OSError`, motivo 4.
- **Logs:**
  - escribir `append_log(source = SOURCE_REMOTE, allowed, reason, holder = HolderRef, credential_label = requested_by, output_id)` en todos los casos de decisión: motivos 11, 2, 3, 4 y abierta;
  - **no** se escribe log si la petición es inválida ni si la salida está ocupada;
  - con motivo 11, `holder = None` y `credential_label = requested_by`.

- [ ] **Paso 1: escribir las pruebas en `test_output_test.py`.**
  - `test_remote_open_con_permiso_abre`: la trama lleva la duración configurada y el log tiene `source = 4`, `allowed = 1`, `reason = 0`, `holder_id` y `credential_label`.
  - `test_remote_open_sin_allow_remote_rechaza_motivo_3`: el titular tiene `allow_rf = 1` y `allow_remote = 0`. No se envía trama y el log tiene `allowed = 0`.
  - `test_remote_open_fuera_de_horario_rechaza`: incluye una ventana que cruza la medianoche, con un reloj falso que se inyecta igual que en `access.py`.
  - `test_remote_open_titular_desconocido_motivo_11`.
  - `test_remote_open_salida_deshabilitada_motivo_2`, frente a `test_output`, que sí la activa.
  - `test_remote_open_ocupada`.
  - `test_remote_open_peticion_invalida`: casos `holder_uuid` en mayúsculas, `output = True` y `op` desconocido.
  - En `test_access.py`: `permission_allows` con `METHOD_REMOTE`.
- [ ] **Paso 2:** confirmar que fallan.
- [ ] **Paso 3:** implementar. Si necesitas inyectar `now`, agrega a `OutputTester` un parámetro `now = datetime.now` siguiendo el patrón de `access.py`.
- [ ] **Paso 4:** `.venv/bin/pytest`.

### Tarea 3: Agente — orden `remote_open` y `allow_remote` en la sincronización

**Archivos:**
- Modificar: `panel/backend/acceso/cloud/mqtt_link.py` (`COMMAND_TYPES`), `runner.py` (`_command` reenvía `test_output` y `remote_open`), `commands.py` (`_Order` con `kind` y `holder_uuid`), `api.py` (`post_command_result` con `reason` opcional) y `mapping.py` (`allow_remote` en `FIELDS`, `_SELECT`, `_BOOLEANS` y `_upsert_permission`).
- Pruebas: `tests/cloud/test_commands.py`, `test_mqtt_link.py`, `test_runner.py`, `test_sync.py` y `fake_cloud.py`.

**Interfaces:**
- **`CommandWorker`:**
  - con `type = "remote_open"` exige además `holder_uuid`, un uuid canónico;
  - llama al daemon con `{"op": "remote_open", "output", "holder_uuid", "requested_by"}`;
  - publica `post_result(command_id, ok, detail, reason)`, donde `reason` es el entero que devuelve el daemon o `None`;
  - con `test_output` publica `reason = None`;
  - la deduplicación y la caducidad son las mismas para los dos tipos.
- **`CloudApi.post_command_result(command_id, ok, detail, reason=None)`:** envía `reason` solo si no es `None`.
- **`mapping.py`:**
  - `FIELDS["permissions"]` suma `allow_remote`;
  - al leer un permiso que viene de la nube, si falta `allow_remote` se toma `False` **en lugar** de lanzar `InvalidChange`, como excepción explícita para ese campo;
  - al subir, siempre se envía.

- [ ] **Paso 1: escribir las pruebas.**
  - `remote_open` válido llama al daemon con el payload exacto y publica el `reason`.
  - Sin `holder_uuid`, o con uno mal formado, la orden se descarta.
  - Una orden repetida o caducada no llama al daemon.
  - `mqtt_link` reenvía `remote_open`.
  - `runner` hace `submit` solo en el estado `active`.
  - `test_sync`:
    - un permiso de la nube sin `allow_remote` se aplica con `0`;
    - uno con `true` se aplica con `1`;
    - el push incluye `allow_remote`;
    - la suma de verificación incluye el campo.
- [ ] **Paso 2:** confirmar que fallan.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `.venv/bin/pytest`.

### Tarea 4: Nube — datos (migración, push, proyección, importación y órdenes)

**Archivos:**
- Crear: la migración `remote_open`, con `npx supabase migration new remote_open`.
- Modificar:
  - `cloud/src/lib/device/contract.ts`: `permissions.allow_remote: z.boolean().optional()` y `commandResultSchema.reason: entero(0,255).nullable().optional()`;
  - `cloud/src/lib/device/projection.ts`: `projectPermission` con `allow_remote: ruleForPanel?.allow_remote ?? false` y la columna en `SOURCE_COLUMNS.profile_panel_rules`;
  - `cloud/src/lib/profile-view.ts`, los tipos `RuleRow` y `PanelRuleInput`;
  - `cloud/src/lib/device/imports.ts`, en `planPerfil`;
  - `cloud/src/lib/device/commands.ts`, para guardar `reason`.
- Pruebas: `cloud/supabase/tests/remote_open.test.sql` (nueva), `cloud/tests/device/pull.test.ts`, `push.test.ts`, `import.test.ts` y `command-result.test.ts`.

**Interfaces (SQL de la migración):**
- `alter table profile_panel_rules add column allow_remote boolean not null default false`, con grants de insert y update para `authenticated`, igual que `allow_rf`.
- `create or replace` de `private.push_permission`. Escribe `allow_remote = coalesce((p_data->>'allow_remote')::boolean, false)` en el insert. En el update, si el campo no viene, conserva el valor actual.
- `create or replace` de las funciones de importación que leen `allow_rf` con `jsonb_to_recordset`, en su versión vigente de `20261030225254_control_button_panels.sql`. Suman `allow_remote`.
- `panel_commands`:
  - quitar la restricción de `kind` y volver a crearla con `kind in ('test_output','remote_open')`;
  - `holder_id uuid` con `check (kind <> 'remote_open' or holder_id is not null)`;
  - `reason int`;
  - grants de `select` de las columnas nuevas para `authenticated`.

- [ ] **Paso 1: escribir las pruebas.**
  - **pgTAP:** la columna y sus grants; la restricción de `kind`; un `remote_open` sin `holder_id` falla.
  - **pull:** el permiso proyectado siempre trae `allow_remote` (`true` si la regla lo tiene, `false` si no).
  - **push:**
    - un push de permisos **sin** `allow_remote` se aplica y conserva el valor de la nube;
    - uno con `allow_remote: true` lo guarda.
  - **import:** `allow_remote` viaja en el plan.
  - **command-result:** se guarda `reason`; `reason` fuera de rango da 400.
- [ ] **Paso 2:** confirmar que fallan.
- [ ] **Paso 3:** implementar y aplicar en local (`npx supabase db reset`, después `crear-admin-local.sh`).
- [ ] **Paso 4:** `npm test && npm run test:db && npx tsc --noEmit`.

### Tarea 5: Nube — reglas con "Permitir apertura remota" y origen "Remota" en los logs

**Archivos:**
- Modificar:
  - `cloud/src/lib/profiles.ts` (`REGLA_COLUMNAS`, `CAMPOS_REGLA` y `reglaEsquema` con `allow_remote: z.boolean()`, que es obligatorio en la interfaz);
  - `cloud/src/components/access/ProfileRulesEditor.tsx` (casilla "Permitir apertura remota" junto a "Control RF");
  - `cloud/src/lib/api/openapi.ts` (`camposRegla.allow_remote`, y el enum `Log.source` con 4);
  - `cloud/src/lib/log-view.ts` (`SOURCES[4] = "Remota"`, `SOURCE_OPTIONS = [0,1,2,3,4,5]`, la etiqueta de `mediumLabel` para el 4 = `credential_label ?? "Remota"` y `REASONS[11]` si existe un mapa de motivos);
  - `cloud/docs/api.md`.
- Pruebas: `cloud/tests/ui/profiles*.test.ts*`, `cloud/tests/api/profiles.test.ts`, `cloud/tests/api/openapi.test.ts` y `cloud/tests/ui/log-view*.test.ts`.

**Interfaces:**
- `PUT .../rules` de la API: `allow_remote` es **opcional** y vale `false` si falta, para no romper a los clientes de 2A. La interfaz siempre lo envía.

- [ ] **Paso 1: escribir las pruebas.**
  - La casilla aparece y se envía.
  - `saveProfileRulesAs` guarda `allow_remote`.
  - La API acepta reglas sin `allow_remote` (lo toma como `false`) y con `true`.
  - Los logs filtran por `origen=4` y muestran "Remota".
- [ ] **Paso 2:** confirmar que fallan.
- [ ] **Paso 3:** implementar con las skills `frontend-design` y `vercel-react-best-practices`.
- [ ] **Paso 4:** `npm test && npm run lint && npx tsc --noEmit`.

### Tarea 6: API `POST .../outputs/{outputId}/open`

**Archivos:**
- Modificar: `cloud/src/lib/panel-commands.ts`. Generaliza el envío de órdenes con un auxiliar interno que comparten `testOutputAs` y el nuevo `remoteOpenAs`.
- Crear: `cloud/src/app/api/v1/installations/[installationId]/outputs/[outputId]/open/route.ts` y `cloud/tests/api/remote-open.test.ts`.
- Modificar también: `cloud/src/lib/api/openapi.ts` y `cloud/docs/api.md`.

**Interfaces:**
- **`remoteOpenAs(client: DataClient, tenantId, installationId, outputId, holderId, requestedBy): Promise<{commandId: string}>`:**
  - pide acceso `"tecnico"`, que con un actor de API equivale a admin;
  - el titular debe estar vivo en la instalación; si no, `HttpError(400, "El titular no existe.")`;
  - la salida debe existir; si no, 404;
  - si el panel no está activo o no está en línea, 409 "Panel sin conexión";
  - si ya hay una orden pendiente en la salida (23505), 409 "La salida ya tiene una orden en curso.";
  - inserta con `kind = 'remote_open'`, `holder_id` y `requested_by` recortado a 120;
  - publica `{type: "remote_open", command_id, output, holder_uuid: holderId, requested_by, expires_at}` con `expires_at` de `toISOString()`;
  - si falla la publicación, marca la orden como `error` y lanza 502.
- **`awaitCommand(commandId, timeoutMs = 8000): Promise<{status, reason, detail}>`**, en `panel-commands.ts`:
  - consulta cada 250 ms con el cliente admin;
  - se traduce así: `ok` → `"opened"`; `error` con `reason` en {2, 3, 11} → `"denied"`; otro `error` → `"failed"`; pasado el plazo o `expired` → `"timeout"`.
- **Ruta:**
  - `apiRoute` **con** idempotencia;
  - cuerpo `z.strictObject({holder_id: z.guid(), requested_by: z.string().min(1).max(120)})`;
  - responde 200 `{data: {command_id, status, reason, detail}}`.
  - Para que una repetición idempotente devuelva el mismo resultado, la respuesta se guarda al terminar la espera, igual que cualquier respuesta de la API.

- [ ] **Paso 1: escribir `remote-open.test.ts`**, con EMQX simulado (`vi.stubGlobal("fetch")`) y la confirmación simulada con `recordCommandResult` desde la prueba.
  - Un resultado `ok` da `opened`.
  - `ok: false` con `reason: 3` da `denied`, con `reason: 3` y el detalle.
  - Sin resultado en 8 s da `timeout`. Usa temporizadores falsos o baja el plazo con un objeto exportado.
  - El panel fuera de línea da 409.
  - Una orden pendiente en la misma salida da 409.
  - Un titular de otra instalación da 400.
  - La salida de otro tenant da 404.
  - Se publica el payload exacto.
  - Con `Idempotency-Key`, se publica una sola vez.
- [ ] **Paso 2:** confirmar que falla.
- [ ] **Paso 3:** implementar y actualizar OpenAPI: la ruta, el cuerpo, la respuesta y los códigos. La prueba de OpenAPI que recorre las rutas debe pasar.
- [ ] **Paso 4:** `npm test && npx tsc --noEmit && npm run lint`.

### Tarea 7: Documentación y verificación de punta a punta

**Archivos:**
- Modificar:
  - `CLAUDE.md` (esquema v7, etapa 3, conteos de pruebas, origen 4 y motivo 11);
  - `cloud/docs/despliegue.md` (migración `remote_open`, **orden: nube primero —`db push --remote` y luego Vercel— y después el paquete del panel**);
  - `cloud/docs/api.md` (sección "Apertura remota", con un ejemplo `curl` y la tabla de estados y motivos);
  - `panel/README.md` (la casilla de apertura remota y el origen "Remota").

- [ ] **Paso 1:** escribir la documentación.
- [ ] **Paso 2:** correr la batería completa de la nube y del panel, más `bash cloud/e2e/run_e2e.sh`. Todo debe pasar.
