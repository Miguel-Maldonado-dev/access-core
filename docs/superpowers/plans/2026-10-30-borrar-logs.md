# Borrar logs desde la nube — Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development. Los pasos usan casillas (`- [ ]`).

**Objetivo:** que un administrador del tenant borre, desde la página de logs de la nube, todos los logs de una instalación, tanto en la nube como en sus paneles.

**Arquitectura:**
- La nube borra `access_logs` de la instalación, guarda `installations.logs_cleared_at` y registra el borrado en `log_purges`.
- Los paneles reciben `logs_cleared_at` en la respuesta del pull y borran sus logs locales con fecha igual o anterior.
- Un aviso MQTT `sync` sin revisión adelanta el pull de los paneles en línea.
- Los logs atrasados (con `ts` igual o anterior a `logs_cleared_at`) se aceptan pero no se guardan.

**Stack:** Next.js 16 + Supabase (pgTAP y Vitest); Python ≥ 3.9 en el agente del panel.

**Spec:** sección 8 de `docs/superpowers/specs/2026-10-30-controles-por-panel-logs-y-prueba-de-salidas-design.md`.

## Global Constraints

- **Git:** sin commits ni merges; todo queda sin confirmar en `develop`.
- **Idioma:** interfaz, mensajes de error y comentarios en español.
- **Base de datos:**
  - las migraciones se crean con `cd cloud && npx supabase migration new <nombre>` y solo se aplican en local;
  - RLS y GRANT por columna, con `revoke` a `anon`; las funciones privilegiadas van en `private`.
- **Panel:** el esquema v6 no cambia (el estado se guarda en `sync_state`, que ya existe). Los errores de la API de dispositivos van como `{code, message}`.
- **Permisos:** solo el rol `admin` del tenant puede borrar (`requireInstallationAccess(..., "admin")`).
- **Textos exactos:**
  - botón: "Borrar logs";
  - confirmación: "Escribe el nombre de la instalación para confirmar.";
  - error si el nombre no coincide (400): "El nombre no coincide con la instalación.";
  - aviso de éxito: "Se borraron N logs de la nube. Los paneles borran los suyos al sincronizar.".
- **Pruebas:**
  - nube: `cd cloud && npm test && npm run test:db && npm run lint && npx tsc --noEmit && npm run build`;
  - panel: `cd panel/backend && .venv/bin/pytest`.

## Review Focus

1. **Panel apagado durante el borrado:** al volver, borra sus logs locales anteriores a la hora del borrado y no los vuelve a subir (Tareas 2 y 4).
2. **Logs atrasados:** un panel sube logs con `ts` igual o anterior al borrado. La nube los acepta, el cursor del panel avanza y los logs no aparecen en la nube (Tarea 2).
3. **Técnico o usuario de otro tenant:** recibe 403 o 404 y no se borra nada (Tarea 3).
4. **Pull sin cambios** (`since >= R`): también incluye `logs_cleared_at` (Tarea 2).
5. **Borrado repetido:** el panel no repite la operación si ya aplicó esa hora (Tarea 4).

---

### Tarea 1: Datos del borrado (migración y pgTAP)

**Archivos:** migración nueva `log_purges` (con `npx supabase migration new log_purges`) y `cloud/supabase/tests/log_purges.test.sql`.

**Interfaces:**
- **`installations.logs_cleared_at timestamptz` (nula):**
  - la leen los miembros, con un grant de `select` por columna;
  - solo la escribe `service_role`.
- **`public.log_purges`:**
  - columnas: `id bigint generated always as identity primary key`, `tenant_id uuid not null references tenants on delete cascade`, `installation_id uuid not null references installations on delete cascade`, `purged_at timestamptz not null default now()`, `purged_by uuid`, `purged_by_email text not null` y `deleted_count int not null`;
  - RLS con `select` para `private.is_member(tenant_id)`; sin `insert`, `update` ni `delete` para `authenticated`; sin grants para `anon`;
  - índice `(installation_id, purged_at desc)`.

- [ ] **Paso 1:** escribir el pgTAP.
  - Un miembro lee `log_purges` de su tenant.
  - Alguien de otro tenant no lo lee.
  - `authenticated` no puede insertar (42501).
  - `logs_cleared_at` existe y `authenticated` no la puede actualizar.
- [ ] **Paso 2:** confirmar que falla con `npm run test:db`.
- [ ] **Paso 3:** escribir la migración y aplicarla con `npx supabase migration up --local`.
- [ ] **Paso 4:** `npm run test:db` pasa; correr `get_advisors` (o `npx supabase db advisors`) y no debe haber avisos nuevos.

### Tarea 2: El pull lleva la hora del borrado y los logs atrasados se descartan (API de dispositivos)

**Archivos:** `cloud/src/lib/device/contract.ts`, `cloud/src/lib/device/changes.ts` y `cloud/src/lib/device/logs.ts`. Pruebas: `cloud/tests/device/pull.test.ts` y `cloud/tests/device/logs.test.ts`.

**Interfaces:**
- **`PullResponse`** suma el campo `logs_cleared_at: string | null`, en ISO con `toISOString()`. Va en **todas** las respuestas de `listChanges`, también en la página vacía cuando `since >= R`.
- **`storeLogs(panel, logs)`:**
  - lee `installations.logs_cleared_at`;
  - no inserta los logs con `ts <= logs_cleared_at`;
  - la respuesta no cambia: `accepted` cuenta todos los recibidos y `last_local_log_id` es el mayor `local_log_id` recibido, para que el panel avance su cursor.

- [ ] **Paso 1:** escribir las pruebas.
  - En el pull: `logs_cleared_at` es `null` por omisión y lleva la hora en ISO cuando existe, tanto en una página con cambios como en una vacía.
  - En los logs: con `logs_cleared_at` fijado, un lote con un log anterior y uno posterior guarda solo el posterior, y `last_local_log_id` es el mayor de los dos.
- [ ] **Paso 2:** confirmar que fallan.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** correr `npx vitest run tests/device && npx tsc --noEmit`.

### Tarea 3: Acción de borrar y botón en la página de logs (nube)

**Archivos:**
- `cloud/src/lib/panel-commands.ts`, donde se agrega la función;
- `cloud/src/app/t/[tenant]/installations/[id]/logs/actions.ts` y `logs/page.tsx`;
- nuevo `cloud/src/components/logs/PurgeLogsButton.tsx`.

Pruebas: `cloud/tests/ui/panel-commands.test.ts` y `cloud/tests/ui/logs.test.tsx`.

**Interfaces:**
- **`purgeLogsAs(supabase, tenantId, installationId, confirmName: string): Promise<{deleted: number}>`**
  - Exige `requireInstallationAccess(..., "admin")`.
  - Compara `confirmName.trim()` con el nombre de la instalación, exacto y sin distinguir mayúsculas. Si no coincide, lanza `HttpError(400, "El nombre no coincide con la instalación.")`.
  - Con el cliente de administración, en este orden:
    1. fija `installations.logs_cleared_at = now()` (en ISO del servidor);
    2. borra `access_logs` de la instalación con `ts <= esa hora` y cuenta las filas;
    3. inserta en `log_purges` el correo y el id del usuario y el conteo;
    4. publica `{type: "sync"}` a los paneles activos y en línea, con `Promise.allSettled`; si la publicación falla, no se considera error.
- **`purgeLogs(tenantId, installationId, confirmName)`** (acción de servidor):
  - valida con `z.tuple`;
  - usa `runAction` **con** `refresh()` (el comportamiento por omisión), para que la tabla se vacíe.
- **`PurgeLogsButton({ installationName, onPurge })`:**
  - lo muestra la página **solo si** el usuario es `admin`; para saberlo, la página consulta el rol con `requireTenantRole` o con la guarda que ya use;
  - al pulsar "Borrar logs" se abre una confirmación en la página, con un campo para el nombre, un botón "Borrar definitivamente" (deshabilitado hasta que el nombre coincida) y otro "Cancelar";
  - usa `Notices` para el éxito y el error;
  - es accesible: etiqueta en el campo y el foco va al campo al abrir;
  - aplicar las skills `frontend-design` y `vercel-react-best-practices`.

- [ ] **Paso 1:** escribir las pruebas.
  - Datos, contra el Supabase local:
    - un admin borra: `deleted` coincide, los logs desaparecen, `log_purges` tiene la fila y se publica `sync` solo a los paneles en línea (EMQX simulado);
    - un técnico recibe 403 y no se borra nada;
    - si el nombre no coincide, responde 400 y no se borra nada;
    - un usuario de otro tenant recibe 403 o 404.
  - Interfaz:
    - un técnico no ve el botón;
    - "Borrar definitivamente" está deshabilitado hasta escribir el nombre;
    - al confirmar se llama a `onPurge` con el nombre y se muestra el aviso de éxito.
- [ ] **Paso 2:** confirmar que fallan.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** correr `npm test && npm run lint && npx tsc --noEmit && npm run build`.

### Tarea 4: El agente del panel borra sus logs locales

**Archivos:** `panel/backend/acceso/cloud/sync.py` (en el pull), su prueba `panel/backend/tests/cloud/test_sync.py` y `panel/backend/tests/cloud/fake_cloud.py`.

**Interfaces:**
- **Al leer cada página del pull:**
  - `logs_cleared_at` es opcional; si falta o es `null`, se ignora, para seguir siendo compatible con una nube vieja;
  - si trae una hora más nueva que `sync_state['logs_cleared_at']`, se borran los `access_logs` locales con `timestamp <= int(epoch de esa hora)` y se guarda la hora en `sync_state`;
  - todo va en la misma transacción.
- **No se toca** `sync_state['last_log_uploaded']`.
- **Fechas en Python 3.9:** para parsear la hora, reemplazar la `Z` final por `+00:00`.
- **Hora inválida:** se ignora y se registra un aviso, sin tumbar el pull.

- [ ] **Paso 1:** escribir las pruebas en `test_sync.py`.
  - `test_pull_con_logs_cleared_at_borra_logs_anteriores`: tras el pull quedan solo los logs posteriores y `sync_state` guarda la hora.
  - `test_logs_cleared_at_repetido_no_borra_logs_nuevos`: un log creado después del primer borrado sobrevive a un segundo pull con la misma hora.
  - `test_logs_cleared_at_ausente_o_invalido_no_falla`.
  - `test_pull_sin_cambios_igual_aplica_el_borrado`.
- [ ] **Paso 2:** confirmar que fallan.
- [ ] **Paso 3:** implementar y ajustar `FakeCloud` para que pueda devolver `logs_cleared_at`.
- [ ] **Paso 4:** correr `.venv/bin/pytest`.
