# Apertura por llamada (SIM808): plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usa superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans para implementar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`).

**Goal:** que un titular abra llamando al SIM808 del panel: el daemon identifica el número, revisa sus permisos vigentes con `allow_call` y la configuración "Llamadas" del panel, y abre en modo "Una salida" o "Varias salidas" (menú DTMF), con teléfonos y configuración replicados con la nube.

**Architecture:** en el panel, un hilo `gsm` del daemon es el único dueño de `GSM_PORT` (comandos AT) y abre con el mismo `RelayLink` y la misma regla de salida ocupada que "Probar" (`OutputTester.send_if_free`). El esquema local pasa a v8 con `phones`, `call_settings` (una fila) y `permissions.allow_call`, las tres replicadas. En la nube, `phones` es una tabla replicada como `cards`, `panel_call_settings` es por panel como `outputs`, y la proyección solo envía `phones` a paneles v8 con el módulo activado (como los botones por panel).

**Tech Stack:** Python ≥ 3.9, pyserial, SQLite (WAL), FastAPI, pytest; Next.js 16 (panel y nube), Vitest; Supabase/Postgres, pgTAP; EMQX (sin cambios).

**Spec:** `docs/superpowers/specs/2026-11-24-apertura-por-llamada-design.md` (las secciones "Aclaraciones del dueño (2026-11-24)" y "Teléfonos solo a paneles con el módulo activado" mandan sobre lo anterior).

## Global Constraints

- Español en toda la interfaz, mensajes de error y docstrings; errores de la API local `{"detail": "<texto>"}`.
- Sin commits ni merges: cada tarea termina en "sin commit (el dueño confirma)". Rama `develop`.
- `GSM_PORT` en `/etc/acceso/acceso.env`, **9600 baudios**; vacía = función apagada. Con el módulo desactivado en `call_settings`, el daemon **no abre** el puerto aunque exista `GSM_PORT`.
- Arranque AT: `ATE0`, `AT+CLIP=1`, `AT+DDET=1`, `AT+CMEE=2`. Colgar `ATH`, contestar `ATA`, señal `AT+CSQ`, registro `AT+CREG?`.
- Número: se guardan y comparan **10 dígitos**; al normalizar el CLIP se quitan `+`, espacios y guiones y los prefijos `52`/`521`. En la interfaz y la API se capturan 10 dígitos. Número oculto o vacío = desconocido.
- Modos del módulo: **"Una salida"** (`single`: no contesta, `ATH`, abre la salida configurada) y **"Varias salidas"** (`menu`: `ATA`, espera tecla 1–4 **8 s**; salidas elegibles marcadas en la configuración; salida predeterminada opcional; sin ella no abre).
- Regla combinada: la salida `n` abre solo si está activa en la configuración del módulo **y** en el `output_mask` de algún permiso **vigente** (días y horario) con `allow_call` del titular.
- Una llamada a la vez (la segunda se cuelga); máximo **3 aperturas por minuto por número** (cuenta aperturas, en memoria del daemon).
- Logs: origen **6 = "Llamada"**; motivos 0, 2, 3, **12 = "Teléfono desconocido"**, **13 = "Límite de llamadas"**; el número se registra **completo**.
- Permiso: solo `allow_call` (0/1, apagado por omisión), como `allow_rf`. No existen `call_mode` ni `call_output`.
- Número único entre los teléfonos vivos de la instalación (local: `UNIQUE`); alta duplicada: **409 "El número ya está registrado"** (nube) y el mismo texto en `{"detail"}` local.
- `phones` solo viaja (feed, checksums, snapshot, reconciliación) a paneles v8 con `panel_call_settings.enabled`; al desactivar, el panel recibe el borrado de todos sus teléfonos.
- Orden de despliegue: primero la nube (migración y Vercel), después el paquete del panel v8. Panel v7 con la nube nueva ignora teléfonos y llamada; no se revierte la nube con paneles v8.
- Nunca subir bases, respaldos ni `.env`. El PIN sigue sin aparecer en logs.

## Decisiones de Claude que fija este plan

- **[decisión de Claude] Log de llamada:** `access_logs.code = NULL`, `credential_label = "<10 dígitos>"` (o el texto recibido, recortado a 20, si no se pudo normalizar; `"Oculto"` si viene vacío) y `device_id` = tecla DTMF (1–4) cuando aplica. Así no cambia `access_logs` local ni el de la nube (allá `code` es de 32 bits y no cabe un número de 10 dígitos).
- **[decisión de Claude] Tabla local `call_settings`:** una fila (`id = 1`), columnas `enabled`, `mode` (`single`|`menu`), `output_id` (salida de "Una salida", 0–3), `menu_mask` (salidas del menú, 0–15), `default_output` (0–3 o NULL), más `uuid`, `updated_at`, `origin`. En la nube, `panel_call_settings` con las mismas columnas (`output_index` en lugar de `output_id`).
- **[decisión de Claude] Identidad de `call_settings`:** la nube crea una fila por panel (migración para los paneles vivos, `claim_panel`/`import_rows` para los nuevos). El push del panel se aplica a **la fila de su panel** sin importar el uuid local, y el upsert de la nube en el panel siempre escribe la fila `id = 1` y adopta el uuid de la nube (como `outputs`). Un `delete` de `call_settings` nunca se aplica en el panel.
- **[decisión de Claude] Versión del panel en la nube:** el agente v8 envía el encabezado `X-Acc-Schema: 8` en todas las peticiones de dispositivo; sin él, la nube trata al panel como v7 y **no** le envía `phones`, `call_settings` ni `allow_call` (un panel v7 aborta el lote con una tabla desconocida).
- **[decisión de Claude] Activar/desactivar en la nube:** un cambio de `panel_call_settings` sube la revisión (y con ello el aviso MQTT `sync` existente). El feed, al ver ese cambio, emite el upsert de `call_settings` y además el upsert de todos los teléfonos vivos (si quedó activado) o el `delete` de todos (si quedó desactivado), con la revisión de ese cambio. Los cambios de `phones` a un panel desactivado no se emiten.
- **[decisión de Claude] Al desactivar localmente:** la web local borra los teléfonos locales junto con el cambio (sin pasar por la bandeja, con `sync_guard`), para que el número no quede en la placa; si el panel está vinculado, la nube vuelve a enviarlos al reactivar.
- **[decisión de Claude] Estado del módulo:** el daemon atiende la operación `gsm_status` en su socket (`{"ok", "enabled", "port", "connected", "registered", "signal"}`); `signal` es el valor `rssi` de `+CSQ` (0–31, `99` = sin dato → `null`). La web lo pide en `GET /api/calls/status`. La nube no muestra el estado (solo la web local, como dice la aclaración 2).
- **[decisión de Claude] Recarga de configuración:** el hilo `gsm` relee `call_settings` cada `RECONNECT_SECONDS` (3 s) mientras espera; si se desactiva, cierra el puerto.
- **[decisión de Claude] Salida predeterminada del menú:** debe estar en `menu_mask`; la API local y la nube rechazan lo contrario con "La salida predeterminada debe estar entre las salidas del menú.". "Una salida" ignora `menu_mask` y `default_output`.
- **[decisión de Claude] Panel de prueba de la nube:** la configuración "Llamadas" de la nube solo la edita admin; técnico la ve.
- **[decisión de Claude] Logs de motivos:** salida ocupada → motivo 0, `allowed=0`, detalle no se guarda (igual que la remota responde ocupada; aquí sí se registra porque no hay quien reciba la respuesta); salida configurada deshabilitada o inexistente → 2; sin permiso para ninguna salida elegible o menú sin tecla válida y sin predeterminada → 3; límite → 13; número no registrado u oculto → 12.

## Review Focus

1. **CLIP con formatos reales** (`"+5215512345678",145`, `"5512345678",129`, `"",128`, número internacional de 11 dígitos): se normaliza o se trata como desconocido sin excepción en el hilo. Prueba: `test_normalize_phone_*` y `test_clip_international_is_unknown` (Tarea 2).
2. **`RING` repetido sin `+CLIP` y `NO CARRIER` del que llama a media espera del menú:** el hilo no se queda atorado ni procesa la misma llamada dos veces. Prueba: `test_ring_repeats_handled_once` y `test_menu_caller_hangs_up` (Tarea 3).
3. **Cambio de `call_settings` mientras hay llamada o puerto abierto (desactivar):** se cuelga/cierra en ≤ 3 s y no se abre nada. Prueba: `test_disable_closes_port` (Tarea 3).
4. **Panel v7 contra la nube nueva:** el feed, checksums y snapshot no incluyen `phones`/`call_settings` ni `allow_call` sin `X-Acc-Schema: 8`. Prueba: `listChanges omite phones a panel v7` (Tarea 7).
5. **Número capturado con espacios o guiones (`55 1234-5678`) y duplicado tras normalizar:** se guarda como 10 dígitos y el duplicado da 409 con el texto fijo. Prueba: `test_create_phone_normalizes_and_rejects_duplicate` (Tarea 4) y `crear teléfono normaliza y rechaza duplicado` (Tarea 8).

---

### Task 1: Esquema local v8 y migración v7 → v8

**Files:**
- Modify: `panel/backend/acceso/constants.py`, `panel/backend/acceso/schema.py`, `panel/backend/acceso/migrate.py`
- Create: `panel/backend/acceso/phones.py`
- Test: `panel/backend/tests/test_schema_v8.py`, `panel/backend/tests/test_migrate.py`, `panel/backend/tests/test_phones.py`

**Interfaces:**
- Produces:
  - `constants.py`: `SCHEMA_VERSION = 8`; `REPLICATED_TABLES` agrega `"phones", "call_settings"` al final; `SOURCE_CALL = 6`; `REASON_UNKNOWN_PHONE = 12`; `REASON_CALL_LIMIT = 13`; `CALL_MENU_TIMEOUT_S = 8`; `CALL_LIMIT_PER_MINUTE = 3`; `GSM_BAUD = 9600`; `CALL_MODES = ("single", "menu")`.
  - Tabla `phones(phone_id INTEGER PRIMARY KEY, holder_id INTEGER NOT NULL REFERENCES holders ON DELETE CASCADE, number TEXT NOT NULL UNIQUE CHECK(length(number)=10 AND number NOT GLOB '*[^0-9]*'), description TEXT NOT NULL DEFAULT '', uuid, updated_at, origin)`.
  - Tabla `call_settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK 0/1, mode TEXT NOT NULL DEFAULT 'single' CHECK IN CALL_MODES, output_id INTEGER NOT NULL DEFAULT 0 CHECK 0–3, menu_mask INTEGER NOT NULL DEFAULT 0 CHECK 0–15, default_output INTEGER CHECK(NULL o 0–3), uuid, updated_at, origin)`; `create_schema` inserta la fila 1 con uuid nuevo.
  - `permissions.allow_call INTEGER NOT NULL DEFAULT 0 CHECK(allow_call IN (0,1))`, al final de la tabla (como lo deja `ALTER`).
  - `acceso/phones.py`: `normalize_phone(raw: str) -> Optional[str]` (CLIP: quita todo lo que no sea dígito; 13 dígitos con `521` o 12 con `52` → últimos 10; 10 → igual; otro largo → `None`) y `parse_phone_input(raw: str) -> str` (captura: quita espacios y guiones; exige exactamente 10 dígitos o lanza `ValueError("El número debe tener 10 dígitos.")`).

- [ ] **Step 1: Escribir las pruebas que fallan**

```python
# tests/test_phones.py
@pytest.mark.parametrize("raw,expected", [("+5215512345678", "5512345678"), ("525512345678", "5512345678"),
    ("55 1234-5678", "5512345678"), ("5512345678", "5512345678"), ("", None), ("12345", None), ("15551234567", None)])
def test_normalize_phone(raw, expected): assert normalize_phone(raw) == expected
def test_parse_phone_input_rejects_short():
    with pytest.raises(ValueError, match="10 dígitos"): parse_phone_input("551234")
# tests/test_schema_v8.py
def test_v8_tables(conn):  # conn con create_schema
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 8
    row = conn.execute("SELECT enabled, mode, output_id, menu_mask, default_output FROM call_settings WHERE id=1").fetchone()
    assert tuple(row) == (0, "single", 0, 0, None)
    assert "allow_call" in [r[1] for r in conn.execute("PRAGMA table_info(permissions)")]
def test_phone_insert_fires_outbox(conn): ...  # INSERT en phones deja una fila 'upsert' de 'phones' en sync_outbox
def test_phone_number_unique(conn): ...        # segundo INSERT con el mismo number → sqlite3.IntegrityError
def test_phone_cascade_on_holder_delete(conn): ...
# tests/test_migrate.py
def test_migrate_v7_to_v8(tmp_path):
    # base v7 (create_schema de v7 congelado o fixture) con un permiso y un titular
    result = migrate(db)
    assert (result.from_version, result.to_version) == (7, 8) and result.backup_path.exists()
    # permiso conserva uuid/updated_at, allow_call == 0; existe call_settings fila 1; sync_outbox sin filas nuevas
```

- [ ] **Step 2: Correr y ver que fallan** — `cd panel/backend && .venv/bin/pytest tests/test_phones.py tests/test_schema_v8.py tests/test_migrate.py -q` → FAIL (`ImportError`/`user_version == 7`).

- [ ] **Step 3: Implementar** — `schema.py` agrega las dos tablas a `SCHEMA_SQL` y `allow_call`; los triggers salen de `REPLICATED_TABLES` (ya genéricos). `migrate.py`: congelar el esquema v7 (`V7_VERSION = 7`), `_V8_STATEMENTS` (ALTER de `allow_call`, `CREATE TABLE` de `phones` y `call_settings`, sus triggers con `_trigger`, e `INSERT` de la fila 1 con `sync_guard.applying = 1` para no encolarla) y `_convert_v7(conn)` en su transacción; `migrate()` encadena `_convert_v6` → `_convert_v7` y el mensaje de error dice la versión alcanzada. Actualizar el docstring del módulo ("… v7 al esquema v8").

- [ ] **Step 4: Correr las pruebas** — `.venv/bin/pytest -q` → todas pasan (incluidas `test_schema.py`/`test_schema_v7.py`, ajustando sus asserts de versión si fijaban 7).

- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 2: Autorización por llamada y logs

**Files:**
- Modify: `panel/backend/acceso/access.py`, `panel/backend/acceso/output_test.py`
- Create: `panel/backend/acceso/calls.py`
- Test: `panel/backend/tests/test_calls.py`, `panel/backend/tests/test_access.py`

**Interfaces:**
- Consumes: Tarea 1 (`normalize_phone`, constantes, `call_settings`).
- Produces:
  - `access.METHOD_CALL = "call"`; `permission_allows(..., method=METHOD_CALL, reader=None, now)` usa `allow_call == 1` (agregar `p.allow_call` al SELECT).
  - `OutputTester.send_if_free(output: int, duration_ms: int) -> Optional[bool]` (renombrar `_send_if_free`, pública; `None` = ocupada).
  - `calls.CallSettings` (dataclass frozen: `enabled: bool, mode: str, output_id: int, menu_mask: int, default_output: Optional[int]`) y `load_call_settings(conn) -> CallSettings`.
  - `calls.CallRateLimiter` con `allowed(number: str, now: float) -> bool` y `record(number: str, now: float) -> None` (ventana 60 s, `CALL_LIMIT_PER_MINUTE`).
  - `calls.CallAuthorizer(db_path, opener: Callable[[int, int], Optional[bool]], max_entries: int, wall=time.time, now=datetime.now, clock=time.monotonic)` con:
    - `identify(raw_clip: str) -> CallLookup` (`CallLookup(number: Optional[str], label: str, holder: Optional[HolderRef])`);
    - `pre_check(lookup, settings) -> Optional[int]`: motivo de rechazo inmediato (12 desconocido, 13 límite, 3 si ninguna salida elegible del modo pasa `permission_allows`) o `None`;
    - `menu_outputs(lookup, settings) -> FrozenSet[int]` (salidas de `menu_mask` permitidas al titular);
    - `open(lookup, output: int, key: Optional[int]) -> int`: lee `outputs` (`enabled = 1`, si no motivo 2), revisa `permission_allows(METHOD_CALL)` (si no 3), llama `opener`; `None` → motivo 0 con `allowed=0`; `False` → 4; `True` → 0, `allowed=1` y `record` del límite. Siempre registra el log.
    - `reject(lookup, reason: int, key: Optional[int] = None) -> None`: solo registra el log.
  - Log: `source=SOURCE_CALL`, `code=None`, `credential_label=lookup.label`, `device_id=key`, `output_id`.

- [ ] **Step 1: Escribir las pruebas que fallan** (`tests/test_calls.py`, base temporal con `create_schema`, titular "Ana" con teléfono `5512345678` y permiso con `allow_call=1`, `output_mask=0b0011`, todo el día)

```python
def test_identify_unknown_and_hidden(authz):
    assert authz.identify('"",128').holder is None and authz.identify('"",128').label == "Oculto"
def test_clip_international_is_unknown(authz): assert authz.identify('"+15551234567",145').holder is None
def test_open_allowed_logs_full_number(authz, conn):
    assert authz.open(authz.identify('"+5215512345678",145'), 0, None) == REASON_ALLOWED
    log = last_log(conn); assert (log["source"], log["credential_label"], log["code"], log["allowed"]) == (6, "5512345678", None, 1)
def test_open_output_not_in_mask_is_3(authz): assert authz.open(lookup, 2, 3) == REASON_NO_PERMISSION
def test_permission_outside_schedule_is_3(...): ...
def test_disabled_output_is_2(...): ...
def test_busy_output_logs_reason_0_not_allowed(...): ...  # opener devuelve None
def test_rate_limit_after_three_openings(authz):  # tres open() exitosos; pre_check → REASON_CALL_LIMIT
def test_menu_outputs_intersects_settings_and_permissions(authz):
    s = CallSettings(True, "menu", 0, 0b0101, None); assert authz.menu_outputs(lookup, s) == {0}
def test_pre_check_unknown_is_12(...): ...
```

- [ ] **Step 2: Correr y ver que fallan** — `.venv/bin/pytest tests/test_calls.py -q` → FAIL (`ModuleNotFoundError: acceso.calls`).

- [ ] **Step 3: Implementar** `acceso/calls.py` con las firmas de arriba; `identify` busca `phones.number` y une `holders`. Ajustar `output_test.py` (`send_if_free`) y `access.py` (`METHOD_CALL`).

- [ ] **Step 4: Correr** — `.venv/bin/pytest -q` → PASS.

- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 3: Módulo `gsm` del daemon con simulador AT

**Files:**
- Create: `panel/backend/acceso/gsm.py`, `panel/backend/tests/fake_modem.py`
- Modify: `panel/backend/acceso/config.py` (`gsm_port: str = ""`, `gsm_baud: int = GSM_BAUD` al final de `Settings`; `GSM_PORT`, `GSM_BAUD`), `panel/backend/acceso/daemon.py`, `panel/deploy/env.example` (`GSM_PORT=` comentado)
- Test: `panel/backend/tests/test_gsm.py`, `panel/backend/tests/test_daemon.py`, `panel/backend/tests/test_config.py`

**Interfaces:**
- Consumes: Tarea 2 (`CallAuthorizer`, `load_call_settings`, `OutputTester.send_if_free`), `daemon.open_serial_port`.
- Produces:
  - `gsm.GsmService(settings: Settings, authorizer: CallAuthorizer, *, open_port: Callable[[str, int], SerialPort] = open_serial_port, clock=time.monotonic, sleep: Callable[[float], None])` con `run(stop: threading.Event) -> None` (hilo `gsm`), `status() -> Dict[str, Any]` (forma de `gsm_status`, protegido con candado) y `handle(request) -> Dict[str, Any]` para `{"op": "gsm_status"}`.
  - Máquina de estados: `idle` → (`RING` + `+CLIP: "<n>",...`) → `pre_check`; rechazo → `ATH` + `reject`; `single` → `ATH` + `open(settings.output_id)`; `menu` → si `menu_outputs` vacío: `ATH` + `reject(3)`; si no `ATA` y espera `+DTMF: n` hasta `CALL_MENU_TIMEOUT_S`; primera tecla en `menu_outputs` (tecla `n` = salida `n-1`) → `open` + `ATH`; teclas inválidas se guardan y la última va en el log final; 8 s sin tecla válida → `default_output` (si está en `menu_outputs`) o `reject(3, key)`; `NO CARRIER` durante el menú = fin sin tecla (misma regla). Un `RING` durante una llamada en curso → `ATH` sin log (la regla "una a la vez"). `RING` repetidos de la misma llamada se ignoran hasta `NO CARRIER`/fin.
  - Arranque del puerto: `ATE0`, `AT+CLIP=1`, `AT+DDET=1`, `AT+CMEE=2`, cada uno espera `OK` 2 s; sin respuesta → `log.warning("El módulo GSM no responde en %s")`, cierra y reintenta en `RECONNECT_SECONDS`. Cada 30 s en reposo: `AT+CREG?` (`registered` = estado 1 o 5) y `AT+CSQ`.
  - `GSM_PORT` vacío o `enabled = 0` → no abre el puerto; `status()` = `{"ok": True, "enabled": ..., "port": ..., "connected": False, "registered": None, "signal": None}`.
  - `daemon.run_daemon(..., open_gsm: Callable[[str, int], SerialPort] = open_serial_port)`: crea `CallAuthorizer(settings.db_path, tester.send_if_free, ...)` y el hilo `GsmService.run`; `dispatch` manda `gsm_status` a `GsmService.handle`.
  - `tests/fake_modem.py`: `FakeModem` (implementa `SerialPort`; `script: Dict[bytes, bytes]` de respuestas a comandos, `push(line: str)` para inyectar `RING`/`+CLIP`/`+DTMF`/`NO CARRIER`, `written: List[bytes]`, `fail_open: bool`).

- [ ] **Step 1: Escribir las pruebas que fallan** (con `FakeModem` y reloj falso; cada prueba arranca `run` en un hilo y espera eventos con `threading.Event`, sin `sleep` real > 0.5 s)

```python
def test_init_sends_at_commands(): assert modem.written[:4] == [b"ATE0\r", b"AT+CLIP=1\r", b"AT+DDET=1\r", b"AT+CMEE=2\r"]
def test_clip_single_mode_hangs_up_and_opens(): ...   # ATH escrito; relevador recibió build_relay_command(0, …); log motivo 0
def test_hidden_number_hangs_up_logs_12(): ...
def test_unauthorized_hangs_up_logs_3(): ...
def test_menu_valid_key_opens_that_output(): ...     # ATA, +DTMF: 2 → salida 1, ATH, log device_id 2
def test_menu_key_not_allowed_then_timeout_default(): ...  # +DTMF: 4 (no permitida), 8 s → default_output
def test_menu_timeout_without_default_logs_3(): ...
def test_menu_caller_hangs_up(): ...                  # NO CARRIER antes de tecla → mismo resultado que timeout
def test_second_call_during_menu_is_hung_up(): ...
def test_ring_repeats_handled_once(): ...             # 3 RING + 1 CLIP → un solo log
def test_rate_limit_logs_13(): ...
def test_module_not_responding_retries(): ...         # sin OK → warning en caplog y segundo open_port
def test_port_disconnected_retries(): ...             # read lanza SerialException → reabre
def test_disabled_does_not_open_port(): ...           # enabled=0 → open_port nunca llamado
def test_disable_closes_port(): ...                   # UPDATE call_settings enabled=0 → close() en ≤ 3 s (reloj falso)
def test_status_reports_signal_and_registration(): ...# +CSQ: 18,0 y +CREG: 0,1 → signal 18, registered True
# test_config.py: GSM_PORT vacío → "" y GSM_BAUD por omisión 9600
# test_daemon.py: dispatch({"op": "gsm_status"}) responde la forma de status()
```

- [ ] **Step 2: Correr y ver que fallan** — `.venv/bin/pytest tests/test_gsm.py -q` → FAIL.

- [ ] **Step 3: Implementar** `acceso/gsm.py` (lectura por líneas con `\r\n`, búfer propio; una sola escritura a la vez), los cambios de `config.py` y `daemon.py`.

- [ ] **Step 4: Correr** — `.venv/bin/pytest -q` → PASS.

- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 4: API de la web local (teléfonos, llamadas, `allow_call`)

**Files:**
- Create: `panel/backend/acceso/web/routes/phones.py`, `panel/backend/acceso/web/routes/calls.py`
- Modify: `panel/backend/acceso/web/schemas.py`, `panel/backend/acceso/web/app.py`, `panel/backend/acceso/web/routes/permissions.py`
- Test: `panel/backend/tests/test_api_phones.py`, `panel/backend/tests/test_api_calls.py`, `panel/backend/tests/test_api_permissions.py`

**Interfaces:**
- Consumes: Tarea 1 (`parse_phone_input`), Tarea 3 (`gsm_status` por `request_daemon`).
- Produces (todas con sesión, como `cards.py`):
  - `GET /api/phones?holder_id=` → `[{phone_id, holder_id, holder_name, number, description}]`; `POST /api/phones` (`{holder_id, number, description}`) 201; `PUT /api/phones/{phone_id}` (`{holder_id, number, description}`); `DELETE /api/phones/{phone_id}` 204. Duplicado → 409 `"El número ya está registrado"`; número inválido → 422 `"El número debe tener 10 dígitos."`; titular inexistente → el mensaje que usa `cards.py`.
  - `GET /api/calls/settings` → `{enabled, mode, output_id, menu_mask, default_output}`; `PUT /api/calls/settings` con el mismo cuerpo (validación: `mode` en `CALL_MODES`, `default_output` en `menu_mask` → 422 con el texto de la decisión). Si `enabled` pasa a 0, borra `phones` dentro de `applying(conn)` (sin bandeja).
  - `GET /api/calls/status` → respuesta de `gsm_status`; daemon caído → 503 `"El daemon no responde."` (el texto que ya usa la prueba de salidas).
  - Permisos: `allow_call: bool = False` en el esquema de entrada/salida.

- [ ] **Step 1: Escribir las pruebas que fallan**

```python
def test_create_phone_normalizes_and_rejects_duplicate(client):
    assert client.post("/api/phones", json={"holder_id": 1, "number": "55 1234-5678", "description": ""}).json()["number"] == "5512345678"
    r = client.post("/api/phones", json={"holder_id": 2, "number": "5512345678", "description": ""})
    assert r.status_code == 409 and r.json() == {"detail": "El número ya está registrado"}
def test_phone_bad_number_422(client): ...
def test_settings_default_output_outside_menu_422(client): ...
def test_disable_module_deletes_phones_without_outbox(client, conn): ...
def test_status_daemon_down_503(client): ...
def test_permission_allow_call_roundtrip(client): ...
```

- [ ] **Step 2: Correr y ver que fallan** — `.venv/bin/pytest tests/test_api_phones.py tests/test_api_calls.py -q` → FAIL (404).

- [ ] **Step 3: Implementar** las rutas y registrarlas en `app.py`.

- [ ] **Step 4: Correr** — `.venv/bin/pytest -q` → PASS.

- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 5: Frontend local (Teléfonos, Llamadas, casilla "Llamada", logs)

**Files:**
- Create: `panel/frontend/src/app/(panel)/telefonos/page.tsx`, `panel/frontend/src/app/(panel)/llamadas/page.tsx` (+ `page.test.tsx` de ambas), `panel/frontend/src/components/PhoneForm.tsx` (+ `.test.tsx`)
- Modify: `panel/frontend/src/app/(panel)/layout.tsx`, `panel/frontend/src/components/PermissionForm.tsx` (+ test), `panel/frontend/src/lib/types.ts`, `panel/frontend/src/lib/format.ts` (+ test)

**Interfaces:**
- Consumes: rutas de la Tarea 4.
- Produces: menú con "Llamadas" siempre y "Teléfonos" solo si `GET /api/calls/settings` dice `enabled`; página Llamadas: casilla "Activar módulo", modo "Una salida"/"Varias salidas", selector de salida S1–S4 (con alias), casillas de salidas del menú y "Salida predeterminada" (opcional, "Ninguna"), y bloque "Estado del módulo" (Puerto, Registrado en la red Sí/No, Señal `n/31` o "Sin dato"); `PermissionForm` agrega casilla "Llamada" junto a "Control RF"; tabla de permisos abrevia "Llam."; `format.ts`: `SOURCES[6] = "Llamada"`, `REASONS[12] = "Teléfono desconocido"`, `REASONS[13] = "Límite de llamadas"`; la credencial de un log origen 6 muestra `credential_label` y, si hay `device_id`, " · tecla n".

- [ ] **Step 1: Pruebas que fallan (Vitest):** `PhoneForm` rechaza "551234" con "El número debe tener 10 dígitos."; la página Llamadas oculta salidas del menú en modo "Una salida"; el layout oculta "Teléfonos" con `enabled: false`; `format` traduce 6, 12 y 13; `PermissionForm` envía `allow_call`.
- [ ] **Step 2:** `cd panel/frontend && npm test` → FAIL.
- [ ] **Step 3: Implementar** con las skills `frontend-design` y `vercel-react-best-practices`, siguiendo `tarjetas/page.tsx` y `CardForm.tsx`.
- [ ] **Step 4:** `npm test && npm run lint && npm run build` → todo pasa.
- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 6: Agente del panel (mapping, sync, encabezado de versión)

**Files:**
- Modify: `panel/backend/acceso/cloud/mapping.py`, `panel/backend/acceso/cloud/sync.py`, `panel/backend/acceso/cloud/api.py`
- Test: `panel/backend/tests/cloud/test_sync.py`, `panel/backend/tests/cloud/fake_cloud.py`, `panel/backend/tests/cloud/test_checksum.py`

**Interfaces:**
- Consumes: Tarea 1.
- Produces:
  - `FIELDS["phones"] = ("holder_id", "number", "description")` (holder por uuid, como `cards`); `FIELDS["call_settings"] = ("enabled", "mode", "output_id", "menu_mask", "default_output")`; `FIELDS["permissions"]` agrega `allow_call`; `_BOOLEANS` agrega `allow_call`; `_OPTIONAL["permissions"]["allow_call"] = False`.
  - `UPSERT_ORDER`: `phones` después de `holders`, `call_settings` al final; `DELETE_ORDER`: `phones` antes de `holders`; `_CHILDREN["holders"]` incluye `phones`.
  - `_upsert_phone` (libera un número ocupado por otro uuid con `_release`, como `_upsert_card`) y `_upsert_call_settings` (siempre `id = 1`, adopta el uuid de la nube); `apply_delete("call_settings", …)` no hace nada.
  - Reconciliación (`sync.py`): `call_settings` se trata como `outputs` (solo toma el uuid y los valores de la nube; nunca se borra); `phones` como `cards`; `GUARDED_TABLES` sin cambios.
  - `api.py`: todas las peticiones llevan `X-Acc-Schema: str(SCHEMA_VERSION)`.

- [ ] **Step 1: Pruebas que fallan:** `test_pull_applies_phone_upsert_and_delete`, `test_pull_call_settings_adopts_cloud_uuid`, `test_pull_ignores_call_settings_delete`, `test_push_phone_change`, `test_reconcile_phones_by_checksum`, `test_requests_send_schema_header` (en `fake_cloud.py`, registrar los encabezados recibidos).
- [ ] **Step 2:** `.venv/bin/pytest tests/cloud -q` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** `.venv/bin/pytest -q` → PASS.
- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 7: Migración de la nube (phones, panel_call_settings, allow_call)

**Files:**
- Create: `cloud/supabase/migrations/20261124120000_phones_calls.sql`, `cloud/supabase/tests/phones_calls.test.sql`

**Interfaces:**
- Produces:
  - `public.phones(id, tenant_id, installation_id, holder_id, number text, description text, revision, updated_at, updated_by, origin, deleted_at)` con FK `(installation_id, holder_id)` como `cards_holder_fkey`; `check (deleted_at is not null or number ~ '^[0-9]{10}$')`; índice único parcial `phones_number_live_key (installation_id, number) where deleted_at is null`; índice `(installation_id, holder_id)`; triggers `phones_before_write`, revisión y auditoría como `cards`; RLS y grants como `cards` (insert `(installation_id, number, holder_id, description)`, update `(number, holder_id, description, deleted_at)`); el borrado en cascada lógico del titular incluye `phones` (el mapa de `20261027052909_replicated.sql` línea ~391).
  - `public.panel_call_settings(id, tenant_id, installation_id, panel_id, enabled boolean default false, mode text check in ('single','menu') default 'single', output_index int 0–3 default 0, menu_mask int 0–15 default 0, default_output int null 0–3, check default_output null o en menu_mask, revision, updated_at, updated_by, origin, deleted_at)`, único vivo por `panel_id`; select para miembros, update `(enabled, mode, output_index, menu_mask, default_output)` solo admin (política con el helper de rol de admin que usa `outputs`/`tenant_admin_guard`); una fila por cada panel vivo (insert en la migración) y en `claim_panel`/`import_rows`.
  - `profile_panel_rules.allow_call boolean not null default false` (grants como `allow_rf`).
  - Redefiniciones completas desde su última versión (solo cambia lo de este plan): `private.push_row_base` (columnas de `phones`), `private.push_permission_base` (`allow_call` opcional: se conserva el de la nube si no viene, false al crear), `private.import_rows` (desde `20261102225408_remote_open.sql`: `phones` y `call_settings` del plan si vienen, `allow_call` false si no viene), `public.apply_panel_change` (`'phones'` por `push_row`; `'call_settings'` actualiza la fila del panel `p_panel_id` y responde `applied`, con LWW por `updated_at`), `private.unique_conflict_version` (rama `phones_number_live_key`), `private.scrub_deleted_row` (`phones`: `number := ''`, `description := ''`), `private.purge_deleted_rows` (incluye `phones`), los `check (table_name in …)` de `audit_log`, `sync_conflicts`, `device_changes`, `purged_rows` y `panel_imports` que enumeran tablas, y `public.delete_installation` si enumera tablas. `private.cleanup_orphan_panel_rows` borra `panel_call_settings` de paneles revocados.

- [ ] **Step 1: pgTAP que falla** (`phones_calls.test.sql`): número único vivo (segundo insert → `23505`; tras borrar el primero, se permite); número de 9 dígitos → `23514`; RLS: otro tenant no ve; técnico no puede actualizar `panel_call_settings`, admin sí; borrar un teléfono lo vacía (`number = ''`); borrar el titular borra lógicamente sus teléfonos; `purge_deleted_rows` lo elimina y deja lápida; cada panel vivo tiene su fila de `panel_call_settings`; `apply_panel_change('call_settings', …)` actualiza la fila del panel aunque el id no coincida; `push_permission` sin `allow_call` conserva el valor.
- [ ] **Step 2:** `cd cloud && npx supabase db reset && npm run test:db` → FAIL en el archivo nuevo.
- [ ] **Step 3: Escribir la migración** (encabezado de comentarios como `remote_open.sql`, con el orden de despliegue).
- [ ] **Step 4:** `npm run test:db` → PASS (todas, incluidas las existentes).
- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 8: Feed, checksums, snapshot e importación con proyección condicionada

**Files:**
- Modify: `cloud/src/lib/device/contract.ts`, `cloud/src/lib/device/auth.ts`, `cloud/src/lib/device/projection.ts`, `cloud/src/lib/device/changes.ts`, `cloud/src/lib/device/apply.ts`, `cloud/src/lib/device/imports.ts`, `cloud/src/lib/device/logs.ts` (sin cambios de forma; solo verificar origen 6)
- Test: los `*.test.ts` vecinos de cada archivo

**Interfaces:**
- Consumes: Tarea 7.
- Produces:
  - `contract.ts`: `TABLES` agrega `"phones", "call_settings"`; `dataSchemas.phones = {holder_id: uuid, number: /^[0-9]{10}$/, description: texto}`; `dataSchemas.call_settings = {enabled, mode: enum, output_id: 0–3, menu_mask: 0–15, default_output: 0–3 | null}`; `permissions.allow_call: z.boolean().optional()`; el snapshot de importación acepta `phones` y `call_settings` ausentes (panel v7).
  - `auth.ts`: `Panel.schema: number` desde `X-Acc-Schema` (entero válido; ausente o inválido → 7).
  - `projection.ts`: `SourceTable` agrega `"phones" | "panel_call_settings"`; `PANEL_SOURCES` agrega `panel_call_settings`; `projectPhone(row: PhoneRow): PhoneData`; `projectCallSettings(row: CallSettingsRow): CallSettingsData` (`output_index` → `output_id`); `projectPermission` agrega `allow_call`; `loadCallSettings(admin, panel): Promise<CallSettingsRow | null>`; `panelGetsPhones(panel: Panel, settings: CallSettingsRow | null): boolean` (= `panel.schema >= 8 && settings?.enabled === true`); `liveRows`/`liveRow` de `phones` vacíos si `!panelGetsPhones`; `liveRows` de `call_settings` vacío si `panel.schema < 8`.
  - `changes.ts`: `ORIGENES_PULL` agrega `phones` y `panel_call_settings`; `TABLES` que se reportan en checksums/snapshot se filtran a las conocidas por el panel (`panel.schema < 8` → sin `phones`, `call_settings`; `projectPermission` sin `allow_call`); un cambio de `panel_call_settings` emite `call_settings` upsert y, con la misma revisión, el upsert de todos los teléfonos vivos (activado) o el `delete` de todos los vivos y de los borrados que el panel pudo tener (desactivado: todos los ids de `phones` de la instalación); cambios de `phones` solo si `panelGetsPhones`.
  - `apply.ts`: `cloudData` lleva `call_settings.output_id` → `output_index`.

- [ ] **Step 1: Pruebas que fallan (Vitest):** `listChanges omite phones a panel v7`, `listChanges omite phones con módulo desactivado`, `activar el módulo emite todos los teléfonos vivos con la revisión del cambio`, `desactivar emite delete de todos los teléfonos`, `checksums de panel v8 activado incluye phones y call_settings`, `snapshot de phones vacío con módulo desactivado`, `permissions de panel v7 sin allow_call`, `auth lee X-Acc-Schema`, `importación de panel v7 sin phones`.
- [ ] **Step 2:** `cd cloud && npm test -- src/lib/device` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 9: API pública de teléfonos, lotes, búsqueda, reglas y OpenAPI

**Files:**
- Create: `cloud/src/lib/phones.ts`, `cloud/src/lib/api/phones.ts`, `cloud/src/app/api/v1/installations/[installationId]/phones/route.ts`, `.../phones/[phoneId]/route.ts`, `.../phones/batch/route.ts` (+ tests)
- Modify: `cloud/src/lib/api/batch.ts`, `cloud/src/lib/api/profiles.ts`, `cloud/src/lib/profiles.ts`, `cloud/src/lib/api/openapi.ts`, `cloud/docs/api.md`

**Interfaces:**
- Consumes: Tarea 7.
- Produces:
  - `lib/phones.ts` (modelo `lib/cards.ts`): `PhoneRow {id, holder_id, holder_name, number, description}`, `listPhonesAs`, `getPhoneAs`, `createPhoneAs`, `updatePhoneAs`, `deletePhoneAs`, `parsePhoneInput(raw: string): string` (mismo criterio que el panel: quita espacios y guiones, exige 10 dígitos, mensaje "El número debe tener 10 dígitos."); `23505` de `phones_number_live_key` → `HttpError(409, "El número ya está registrado")`.
  - `api/phones.ts`: `cuerpoCrearTelefono {number, holder_id, description?}`, `cuerpoEditarTelefono {number?, holder_id?, description?}`, `operacionesTelefonos` con la forma de `operacionesTarjetas`; código de error 409 `conflict`.
  - Búsqueda `GET .../phones?numbers=5512345678,5587654321` (hasta `MAX_CODIGOS`; `parseNumbers(texto: string): Set<string>` en `batch.ts` junto a `parseCodes`, con el mismo mensaje de error adaptado a "numbers").
  - `POST .../phones/batch` con `batchRoute(req, installationId, recursoTelefonos)` (mismas reglas de los otros lotes).
  - Reglas de perfil: `allow_call` en lectura y escritura (`profiles.ts`, `api/profiles.ts`).
  - OpenAPI: esquemas `Phone`, `PhoneCreate`, `PhoneUpdate`, rutas nuevas, `allow_call` en reglas, origen 6 y motivos 12–13 en la descripción de logs; `cloud/docs/api.md` con la sección "Teléfonos" y la advertencia de que el identificador de llamada puede falsificarse.

- [ ] **Step 1: Pruebas que fallan:** `crear teléfono normaliza y rechaza duplicado` (409 con el texto fijo), `PATCH sin cambios → 400 "No hay cambios."`, `lote de teléfonos con un duplicado da 409 en ese elemento y 201 en el resto`, `GET ?numbers= filtra`, `numbers inválido → 400`, `reglas aceptan allow_call`, `openapi incluye /phones y allow_call`.
- [ ] **Step 2:** `npm test -- src/lib/api src/app/api/v1` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 10: UI de la nube (Teléfonos, casilla "Llamada", Llamadas por panel, logs)

**Files:**
- Create: `cloud/src/app/t/[tenant]/installations/[id]/telefonos/{page.tsx,actions.ts}`, `cloud/src/app/t/[tenant]/installations/[id]/llamadas/{page.tsx,actions.ts}`, `cloud/src/components/access/{PhonesManager.tsx,PhoneForm.tsx,CallSettingsManager.tsx}` (+ tests), `cloud/src/lib/call-settings.ts`
- Modify: `cloud/src/app/t/[tenant]/installations/[id]/layout.tsx`, `cloud/src/components/access/ProfileRulesEditor.tsx`, `cloud/src/components/access/HoldersManager.tsx` (enlace "Teléfonos" en la ficha, `?holder=`), `cloud/src/lib/log-view.ts`

**Interfaces:**
- Consumes: Tareas 7 y 9 (`lib/phones.ts`).
- Produces:
  - `lib/call-settings.ts`: `CallSettingsRow {id, panel_id, enabled, mode, output_index, menu_mask, default_output}`, `listCallSettingsAs(supabase, tenantId, installationId)` (técnico+), `updateCallSettingsAs(..., id, input)` (admin; misma validación y mensaje de la salida predeterminada que la web local).
  - Pestañas: "Teléfonos" después de "Tarjetas" (lista, buscador por número/titular, alta y edición, como `CardsManager`); "Llamadas" con una tarjeta por panel: "Activar módulo", modo "Una salida"/"Varias salidas", salida con alias de `listOutputsAs`, salidas del menú y predeterminada; técnico la ve en solo lectura.
  - `ProfileRulesEditor`: casilla "Llamada" junto a "Control RF".
  - `log-view.ts`: origen 6 "Llamada", motivos 12 y 13; credencial del origen 6 como en el panel (número y " · tecla n").

- [ ] **Step 1: Pruebas que fallan (Vitest):** `PhoneForm` valida 10 dígitos; `PhonesManager` filtra por número; `CallSettingsManager` deshabilita la edición para técnico y oculta salidas del menú en "Una salida"; `log-view` traduce 6/12/13; `ProfileRulesEditor` envía `allow_call`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implementar** con `frontend-design` y `vercel-react-best-practices`.
- [ ] **Step 4:** `npm test && npm run lint && npm run build` → PASS.
- [ ] **Step 5: sin commit (el dueño confirma)**

### Task 11: Despliegue, udev, documentación y verificación final

**Files:**
- Modify: `panel/deploy/install.sh`, `panel/deploy/test_install_validation.sh`, `panel/deploy/env.example`, `panel/README.md`, `cloud/docs/despliegue.md`, `CLAUDE.md` (estado y esquema v8)
- Create: `panel/deploy/99-sim808.rules.in`
- Test: `panel/deploy/test_install_validation.sh`, `bash cloud/e2e/run_e2e.sh`

**Interfaces:**
- Produces: `install.sh --sim808-usb VID:PID` escribe `/etc/udev/rules.d/99-sim808.rules` (`SUBSYSTEM=="tty", ATTRS{idVendor}=="VID", ATTRS{idProduct}=="PID", SYMLINK+="sim808", GROUP="dialout", MODE="0660"`), recarga udev y, si `GSM_PORT` está vacío, lo fija a `/dev/sim808`; valida `VID:PID` como `^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$` (error en español); agrega `acceso` al grupo `dialout`. En Orange Pi se documenta `GSM_PORT=/dev/ttyS1` o `/dev/ttyS2` con su overlay (`uart1`/`uart2`), sin automatizar.

- [ ] **Step 1: Prueba que falla:** caso en `test_install_validation.sh` para `--sim808-usb zzzz:1` (rechazo) y `1a86:7523` (regla generada en un directorio temporal).
- [ ] **Step 2:** `bash panel/deploy/test_install_validation.sh` → FAIL.
- [ ] **Step 3: Implementar** y documentar: hardware (fuente 3.4–4.4 V, picos de 2 A, capacitor ≥ 1000 µF, tierra común, nivel lógico), riesgos (identificador falsificable: menor confianza que tarjeta o PIN; el modo "Varias salidas" contesta y puede costar; probar `AT+DDET` con el operador real), orden de despliegue y compatibilidad (nube primero; panel v7 ignora; no revertir la nube con paneles v8; volver a v7 exige restaurar `access_control_backup_v7.sqlite`), y la prueba manual en la placa (CLIP, ATH, ATA, DTMF).
- [ ] **Step 4: Verificación completa:** `cd panel/backend && .venv/bin/pytest`; `cd panel/frontend && npm test && npm run lint && npm run build`; `cd cloud && npm test && npm run test:db && npm run lint && npm run build`; `bash cloud/e2e/run_e2e.sh` → todo pasa. Actualizar los conteos de pruebas en `CLAUDE.md`.
- [ ] **Step 5: sin commit (el dueño confirma)**
