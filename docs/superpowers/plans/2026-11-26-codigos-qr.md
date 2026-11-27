# Códigos QR dinámicos (accesos temporales): plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usa superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans para implementar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`).

**Goal:** que un titular (anfitrión) dé accesos temporales por QR (vigencia y N usos por lector) creados desde la API pública, la web de la nube o la web local, y que el panel los valide sin red leyendo el ZK-QR-500 como una tarjeta Wiegand 34.

**Architecture:** el panel pasa a esquema v9: `qr_codes` (replicada), `qr_uses` (solo local), `qr_settings` (una fila: dígito D y tope, la manda la nube) y `permissions.qr_reader_mask`. `handle_event` decide una lectura `0x10` en el orden tabla de QR → tabla de tarjetas → formato de QR → tarjeta desconocida, con rebote de 3 s y el uso sumado en la transacción del log. En la nube, `qr_codes` es una tabla replicada como `phones`; el dígito y el tope viven en `installations` y viajan como `qr_settings`; todo lo de QR se proyecta solo a paneles con `X-Acc-Schema: 9`.

**Tech Stack:** Python ≥ 3.9, SQLite (WAL), FastAPI, pytest; Next.js 16 (panel y nube), Vitest; Supabase/Postgres, pgTAP, pg_cron; librería `qrcode` (npm) para la imagen. EMQX y el protocolo UART no cambian.

**Spec:** `docs/superpowers/specs/2026-11-26-codigos-qr-design.md` (la sección "Aclaraciones tras la revisión" precisa a las anteriores).

## Global Constraints

- Español en interfaz, errores y docstrings; errores de la API local `{"detail": "<texto>"}`. Códigos en **decimal**.
- Sin commits ni merges: cada tarea termina en "Dejar los cambios sin confirmar (el dueño confirma)". Rama `develop`.
- **El protocolo UART no cambia**: el QR llega como tarjeta `0x10` (`AA 10 RR C1..C4 CS 55`); máximo `4294967295`.
- Formato del código con dígito D (1–9, por omisión **9**): D = 1–3 → 10 dígitos `D000000000`–`D999999999`; D = 4 → `4000000000`–`4294967295`; D = 5–9 → 9 dígitos `D00000000`–`D99999999`.
- Código aleatorio con generador criptográfico (`secrets` / `crypto.randomInt`), único por instalación entre los QR vivos, distinto de toda tarjeta viva.
- Orden de decisión en el lector L: tabla de QR → tabla de tarjetas → formato de QR (motivo 14) → tarjeta desconocida (motivo 1).
- Motivos nuevos (los existentes llegan a 13, no chocan): **14 "QR desconocido"**, **15 "QR fuera de vigencia"**, **16 "QR ya usado en este lector"**, **17 "Método no permitido en este lector"**.
- "N usos" = N lecturas válidas **en cada lector**; `max_uses` 1–100, por omisión 1. Una negación (incluida "sin salida") no consume uso. Misma lectura del mismo QR en el mismo lector dentro de **3 s** se ignora (sin log ni uso).
- Vigencia en instantes absolutos: `timestamptz` en la nube, ISO 8601 con zona en la API, UTC en el panel; la interfaz captura y muestra en `America/Mexico_City`.
- `qr_reader_mask = 0` al migrar. Sin edición de QR: se revoca y se crea otro (la API no tiene PUT/PATCH).
- Tope de QR vigentes `qr_max_active` 1–100000, **1000** por omisión; al exceder, 422 **"Se alcanzó el máximo de QR vigentes de la instalación."**
- Tarjeta en el rango de QR: 422 **"Ese código está reservado para QR."**; cambiar D con tarjetas vivas en el nuevo rango: 422 **"Hay tarjetas en ese rango"**.
- Roles: admin y técnico crean, ven y revocan QR; solo admin cambia D y el tope.
- Limpieza: QR vencido hace más de 30 días se borra (nube y panel) con sus usos; borrado definitivo con lápidas como las demás tablas.
- `X-Acc-Schema: 9`; la nube solo envía `qr_codes`, `qr_settings` y `qr_reader_mask` a paneles v9 (activos, en revisión o importando). Un panel v8 con la nube nueva ignora los QR.
- Orden de despliegue: primero la nube (migración y Vercel), después el paquete del panel v9. Volver a v8 exige restaurar `access_control_backup_v8.sqlite`.
- Nunca subir bases, respaldos ni `.env`.

## Decisiones de Claude que fija este plan

- **[decisión de Claude] Origen de log 7 = "QR"**: `source = SOURCE_QR = 7`, `code` = número del QR, `credential_label` = etiqueta del QR (vacía → NULL), `device_id` = lector. En el motivo 14 no hay titular ni etiqueta.
- **[decisión de Claude] Motivo 17 también para tarjeta:** `permission_allows` se reemplaza por `permission_check(...) -> int` que devuelve `REASON_ALLOWED`, `REASON_METHOD_NOT_ALLOWED` (17: ningún permiso del titular tiene el bit de L en la máscara del método, sin importar día ni hora) o el motivo de "sin permiso" del método (3 para tarjeta/QR, 9 para PIN). Así una tarjeta en un lector solo-QR registra 17, no 3. PIN conserva 9 (no se toca el bloqueo, que cuenta 8 y 9).
- **[decisión de Claude] Salida del QR:** la misma regla que tarjeta: la primera salida habilitada cuyo `reader_mask` incluye L; sin ella → motivo 2 (no consume uso).
- **[decisión de Claude] Prioridad de motivos del QR:** host borrado no aplica (la FK en cascada borra sus QR); se evalúa en este orden: QR no habilitado en L para el anfitrión (17) → fuera de vigencia (15) → usos agotados en L (16) → sin salida (2) → permiso de día/hora/salida (3) → abre.
- **[decisión de Claude] Revocar = borrar:** en el panel es `DELETE` (va a la nube como borrado lógico); en la nube es `deleted_at`. No hay estado "revocado" visible: la lista muestra QR vivos con estado calculado "Pendiente" (antes de `valid_from`), "Vigente" o "Vencido".
- **[decisión de Claude] Unicidad del código:** índice único entre QR **no borrados** (incluidos los vencidos hasta su limpieza a 30 días); local: `UNIQUE(code)`. El generador también evita códigos de tarjetas vivas; hasta 20 intentos, luego 503 "No se pudo generar un código de QR único.".
- **[decisión de Claude] Etiqueta:** texto libre de 0 a 60 caracteres.
- **[decisión de Claude] Tope:** cuenta los QR vivos con `valid_until > now()`. En la nube lo hace cumplir un trigger `before insert` con candado por instalación (`pg_advisory_xact_lock`), así cubre API, web y push del panel (un push que excede queda como conflicto). En el panel lo cumple la web local con `qr_settings.max_active`.
- **[decisión de Claude] Ajustes en la nube:** columnas `installations.qr_digit smallint not null default 9 check 1–9`, `installations.qr_max_active int not null default 1000 check 1–100000` y `installations.qr_settings_revision bigint` (la sube `private.bump_revision` al cambiar dígito o tope). Se cambian solo con la RPC `public.set_installation_qr_settings(p_installation uuid, p_digit int, p_max_active int)` (admin). El feed los emite como la tabla `qr_settings` con `id` = id de la instalación.
- **[decisión de Claude] `qr_settings` local:** una fila (`id = 1`) con `digit`, `max_active`, `uuid`, `updated_at`, `origin`; **no** está en la bandeja (sin triggers): la nube manda. La web local solo la edita si el panel no está vinculado (`sync_state.state` distinto de `linked`/activo); vinculado → 409 "El panel está vinculado: el dígito de QR se cambia en la nube.". Al vincular, la importación no la sube: se adopta la de la nube. Su `delete` nunca se aplica.
- **[decisión de Claude] Rebote:** `QrDebounce` en memoria del daemon, clave `(code, reader)`, reloj monotónico, 3 s; solo para códigos encontrados en `qr_codes`.
- **[decisión de Claude] Limpieza:** nube: `private.expire_qr_codes()` pone `deleted_at` a los QR con `valid_until < now() - interval '30 days'`, en el trabajo pg_cron diario `qr-codes-expire`; después `purge_deleted_rows` los elimina con lápida como al resto. Panel: el hilo de retención llama `purge_expired_qr(conn, now)` que los borra dentro de `applying(conn)` (sin bandeja; la nube hace lo mismo) y `qr_uses` cae por cascada.
- **[decisión de Claude] Imagen:** `qrcode@1.5.4` (+ `@types/qrcode@1.5.5`) fijado en el panel y en la nube; `QRCode.toDataURL(String(code), {errorCorrectionLevel: "M", margin: 2, width: 512})`; el PNG se descarga como `qr-<code>.png` con el número debajo en la página (no dentro de la imagen).
- **[decisión de Claude] API pública:** `GET .../qr-codes` acepta `?holder_id=` y `?status=pending|active|expired`; `DELETE` responde 204; `Idempotency-Key` en `POST` como en tarjetas.

## Review Focus

1. **Tarjeta registrada cuyo número cae en el rango de QR y lector con Tarjeta habilitada:** sigue abriendo como tarjeta (no "QR desconocido"). Prueba: `test_registered_card_in_qr_range_still_opens` (Tarea 2).
2. **Cambio de D con QR ya emitidos:** el QR viejo (otro dígito) sigue abriendo porque está en la tabla; un código sin registrar con el D viejo ya no es "QR desconocido" sino tarjeta desconocida. Prueba: `test_old_digit_qr_still_opens_after_digit_change` (Tarea 2).
3. **Reloj y bordes de vigencia** (`now == valid_until`, `now` un segundo antes de `valid_from`): `valid_from <= now < valid_until`. Prueba: `test_validity_bounds` (Tarea 2) y `vigencia con zona horaria` (Tarea 8).
4. **Lectura doble a 2 s y lectura a 4 s del mismo QR de 1 uso en el mismo lector:** la primera se ignora sin log; la segunda se registra 16. Prueba: `test_debounce_then_used` (Tarea 2).
5. **Panel v8 contra la nube nueva / panel v9 contra la nube con módulo viejo de permisos:** v8 no recibe `qr_codes`, `qr_settings` ni `qr_reader_mask`; un push de permiso v8 sin `qr_reader_mask` conserva el de la nube. Prueba: `listChanges omite qr_codes a panel v8` (Tarea 7) y `push_permission sin qr_reader_mask conserva el valor` (Tarea 6).

---

### Task 1: Esquema local v9, migración v8 → v9 y utilidades de formato

**Files:**
- Modify: `panel/backend/acceso/constants.py`, `panel/backend/acceso/schema.py`, `panel/backend/acceso/migrate.py`
- Create: `panel/backend/acceso/qr.py`
- Test: `panel/backend/tests/test_schema_v9.py`, `panel/backend/tests/test_migrate.py`, `panel/backend/tests/test_qr.py` (ajustar asserts de versión en `test_schema.py`, `test_schema_v7.py`, `test_schema_v8.py`)

**Interfaces:**
- Produces:
  - `constants.py`: `SCHEMA_VERSION = 9`; `REPLICATED_TABLES` agrega `"qr_codes"` al final; `SOURCE_QR = 7`; `REASON_QR_UNKNOWN = 14`, `REASON_QR_EXPIRED = 15`, `REASON_QR_USED = 16`, `REASON_METHOD_NOT_ALLOWED = 17`; `QR_DEFAULT_DIGIT = 9`; `QR_DEFAULT_MAX_ACTIVE = 1000`; `QR_MAX_ACTIVE_LIMIT = 100000`; `QR_MAX_USES = 100`; `QR_LABEL_MAX = 60`; `QR_DEBOUNCE_S = 3.0`; `QR_RETENTION_DAYS = 30`.
  - Tabla `qr_codes(qr_id INTEGER PRIMARY KEY, holder_id INTEGER NOT NULL REFERENCES holders ON DELETE CASCADE, code INTEGER NOT NULL UNIQUE CHECK(code BETWEEN 0 AND 4294967295), label TEXT NOT NULL DEFAULT '', valid_from INTEGER NOT NULL, valid_until INTEGER NOT NULL, max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses BETWEEN 1 AND 100), created_at INTEGER NOT NULL, uuid, updated_at, origin, CHECK(valid_until > valid_from))` (segundos UTC); índice `qr_codes_valid_until_idx`.
  - Tabla `qr_uses(qr_id INTEGER NOT NULL REFERENCES qr_codes ON DELETE CASCADE, reader INTEGER NOT NULL CHECK(reader BETWEEN 0 AND 3), count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(qr_id, reader))` — sin triggers de bandeja.
  - Tabla `qr_settings(id INTEGER PRIMARY KEY CHECK(id=1), digit INTEGER NOT NULL DEFAULT 9 CHECK(digit BETWEEN 1 AND 9), max_active INTEGER NOT NULL DEFAULT 1000 CHECK(max_active BETWEEN 1 AND 100000), uuid TEXT, updated_at INTEGER, origin TEXT)` — sin triggers; `create_schema` inserta la fila 1.
  - `permissions.qr_reader_mask INTEGER NOT NULL DEFAULT 0 CHECK(qr_reader_mask BETWEEN 0 AND 15)` al final.
  - `acceso/qr.py`: `qr_range(digit: int) -> Tuple[int, int]`; `looks_like_qr(code: int, digit: int) -> bool` (= dentro de `qr_range`); `generate_code(conn: sqlite3.Connection, digit: int, *, rand: Callable[[int, int], int] = secrets_randbelow_range) -> int` (evita `qr_codes.code` y `cards.card_code`; 20 intentos o `QrCodeExhausted`); `get_qr_settings(conn) -> QrSettings` (dataclass frozen `digit: int, max_active: int`).

- [ ] **Step 1: Escribir las pruebas que fallan**

```python
# tests/test_qr.py
@pytest.mark.parametrize("d,lo,hi", [(1, 1000000000, 1999999999), (3, 3000000000, 3999999999),
    (4, 4000000000, 4294967295), (5, 500000000, 599999999), (9, 900000000, 999999999)])
def test_qr_range(d, lo, hi): assert qr_range(d) == (lo, hi)
def test_looks_like_qr(): assert looks_like_qr(912345678, 9) and not looks_like_qr(12345678, 9) and not looks_like_qr(9123456789, 9)
def test_generate_skips_taken(conn):  # rand devuelve primero un código de tarjeta viva y luego uno libre
    assert generate_code(conn, 9, rand=seq([900000001, 900000002])) == 900000002
def test_generate_exhausted(conn):
    with pytest.raises(QrCodeExhausted): generate_code(conn, 9, rand=lambda lo, hi: 900000001)
# tests/test_schema_v9.py
def test_v9_tables(conn):
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
    assert tuple(conn.execute("SELECT digit, max_active FROM qr_settings WHERE id=1").fetchone()) == (9, 1000)
    assert "qr_reader_mask" in [r[1] for r in conn.execute("PRAGMA table_info(permissions)")]
def test_qr_insert_fires_outbox(conn): ...      # INSERT en qr_codes → fila 'upsert' de 'qr_codes' en sync_outbox
def test_qr_uses_not_in_outbox(conn): ...       # INSERT en qr_uses → sync_outbox sin filas nuevas
def test_qr_settings_not_in_outbox(conn): ...
def test_qr_cascade_on_holder_delete(conn): ... # borra qr_codes y qr_uses
def test_qr_validity_check(conn): ...           # valid_until <= valid_from → IntegrityError
# tests/test_migrate.py
def test_migrate_v8_to_v9(tmp_path):
    result = migrate(db_v8)
    assert (result.from_version, result.to_version) == (8, 9) and result.backup_path.name == "access_control_backup_v8.sqlite"
    # permiso conserva uuid/updated_at con qr_reader_mask == 0; qr_settings fila 1 (9, 1000); sync_outbox sin filas nuevas
```

- [ ] **Step 2: Correr y ver que fallan** — `cd panel/backend && .venv/bin/pytest tests/test_qr.py tests/test_schema_v9.py tests/test_migrate.py -q` → FAIL (`ModuleNotFoundError: acceso.qr`, `user_version == 8`).
- [ ] **Step 3: Implementar** — `schema.py`: tablas e índice en `SCHEMA_SQL` (los triggers salen de `REPLICATED_TABLES`). `migrate.py`: `V8_VERSION = 8`, congelar la lista de tablas replicadas de v8, `_V9_STATEMENTS` (ALTER `qr_reader_mask`, `CREATE TABLE` de las tres, triggers de `qr_codes` con `_trigger`, `INSERT` de `qr_settings` fila 1) y `_convert_v8(conn)`; `migrate()` encadena `_convert_v7` → `_convert_v8`; `_detect_version` acepta 8; docstring "… al esquema v9". `qr.py` con las firmas de arriba.
- [ ] **Step 4: Correr** — `.venv/bin/pytest -q` → todas pasan.
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 2: Autorización de QR en el daemon

**Files:**
- Modify: `panel/backend/acceso/access.py`, `panel/backend/acceso/logs.py`, `panel/backend/acceso/daemon.py`, `panel/backend/acceso/calls.py` (usa `permission_check`)
- Test: `panel/backend/tests/test_access_qr.py`, `panel/backend/tests/test_access.py`, `panel/backend/tests/test_daemon.py`, `panel/backend/tests/test_logs.py`

**Interfaces:**
- Consumes: Tarea 1 (`looks_like_qr`, `get_qr_settings`, constantes).
- Produces:
  - `access.METHOD_QR = "qr"`; `permission_check(conn, holder_id: int, output_id: int, method: str, reader: Optional[int], now: datetime) -> int` (ver decisión del motivo 17; agrega `p.qr_reader_mask` al SELECT); `permission_allows(...)` queda como `permission_check(...) == REASON_ALLOWED` para no romper `calls.py`/remota.
  - `authorize_qr(conn, qr: sqlite3.Row, reader: int, now: datetime) -> Decision` (orden de motivos de la decisión de Claude; `Decision.qr_id: Optional[int]`).
  - `authorize_card` usa `permission_check(METHOD_CARD)` (devuelve 17 o 3).
  - `handle_event(..., qr_debounce: Optional[QrDebounce] = None, clock: Callable[[], float] = time.monotonic)`: para `CardRead`: busca `qr_codes.code`; si existe → rebote (`qr_debounce.seen(code, reader, clock())` verdadero → `AccessOutcome(False, REASON_QR_USED, None, None)` sin log) → `authorize_qr`, `source = SOURCE_QR`; si no, `cards`; si no y `looks_like_qr(code, digit)` → `Decision(REASON_QR_UNKNOWN)` con `SOURCE_QR`; si no → `REASON_UNKNOWN_CARD` como hoy.
  - `class QrDebounce` con `seen(code: int, reader: int, now: float) -> bool` (registra la lectura; verdadero si hubo otra en < `QR_DEBOUNCE_S`; descarta entradas viejas).
  - `logs.append_log(..., qr_use: Optional[Tuple[int, int]] = None)`: si viene `(qr_id, reader)` hace `INSERT … ON CONFLICT(qr_id, reader) DO UPDATE SET count = count + 1` en la **misma transacción** que el log. `handle_event` lo pasa solo si `reason == REASON_ALLOWED` (tras enviar al relevador; un `REASON_UART_ERROR` no consume).
  - `logs.purge_expired_qr(conn, now: float, days: int = QR_RETENTION_DAYS) -> int` (borra `valid_until < now - days*86400` dentro de `applying(conn)`); `_retention_loop` la llama después de purgar logs.
  - `daemon._serve` crea un `QrDebounce` y lo pasa a `handle_event`.

- [ ] **Step 1: Escribir las pruebas que fallan** (`tests/test_access_qr.py`: titular "Ana" con permiso `output_mask=1`, `card_reader_mask=0b0001`, `qr_reader_mask=0b0011`, todo el día; salida 0 con `reader_mask=0b1111`; QR `912345678` de 1 uso, vigente)

```python
def test_qr_opens_and_counts_use(conn):
    out = handle_event(conn, CardRead(reader=1, code=912345678), send, now=NOW, max_entries=1000, qr_debounce=QrDebounce())
    assert out.allowed and conn.execute("SELECT count FROM qr_uses").fetchone()[0] == 1
    log = last_log(conn); assert (log["source"], log["code"], log["credential_label"], log["device_id"]) == (7, 912345678, "Visita Juan", 1)
def test_second_read_same_reader_is_16(conn): ...       # a +10 s → reason 16, count sigue en 1
def test_one_use_per_reader(conn): ...                   # lector 0 y lector 1 abren una vez cada uno
def test_debounce_then_used(conn): ...                   # 2 s → None log_id y sin log; 4 s → 16
def test_validity_bounds(conn): ...                      # now == valid_until → 15; valid_from - 1 → 15; valid_from → abre
def test_qr_reader_not_enabled_is_17(conn): ...          # lector 2 (sin bit QR) → 17, sin uso
def test_unknown_qr_format_is_14(conn): ...              # 987654321 no registrado → 14, source 7, holder NULL
def test_registered_card_in_qr_range_still_opens(conn): ...  # tarjeta 955555555 en lector 0 → 0, source 0
def test_card_in_qr_only_reader_is_17(conn): ...         # tarjeta en lector 1 (solo QR) → 17
def test_old_digit_qr_still_opens_after_digit_change(conn): ...  # digit=5; QR 912345678 abre; 911111111 → 1
def test_no_output_does_not_consume(conn): ...           # salidas deshabilitadas → 2, qr_uses vacío
def test_schedule_outside_is_3_without_use(conn): ...
def test_uart_error_does_not_consume(conn): ...          # send lanza OSError → 4, qr_uses vacío
def test_purge_expired_qr(conn): ...                     # vencido hace 31 días se borra (y sus usos), sin bandeja; hace 29 no
```

- [ ] **Step 2: Correr y ver que fallan** — `.venv/bin/pytest tests/test_access_qr.py -q` → FAIL.
- [ ] **Step 3: Implementar** las firmas de arriba; ajustar `test_access.py` donde una tarjeta sin bit de lector esperaba 3 (ahora 17).
- [ ] **Step 4: Correr** — `.venv/bin/pytest -q` → PASS.
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 3: API de la web local (QR, ajustes, permisos y tarjetas en rango)

**Files:**
- Create: `panel/backend/acceso/store/qr_codes.py`, `panel/backend/acceso/web/routes/qr.py`
- Modify: `panel/backend/acceso/store/cards.py`, `panel/backend/acceso/store/permissions.py`, `panel/backend/acceso/web/schemas.py`, `panel/backend/acceso/web/app.py`, `panel/backend/acceso/web/routes/permissions.py`
- Test: `panel/backend/tests/test_api_qr.py`, `panel/backend/tests/test_api_cards.py`, `panel/backend/tests/test_api_permissions.py`

**Interfaces:**
- Consumes: Tarea 1 (`generate_code`, `qr_range`, `get_qr_settings`).
- Produces (con sesión, como `cards.py`):
  - `store/qr_codes.py`: `list_qr(conn, holder_id: Optional[int], now: int) -> List[dict]` (`{qr_id, holder_id, holder_name, code, label, valid_from, valid_until, max_uses, status, uses: {reader: count}}`, `status` en `pending|active|expired`), `create_qr(conn, holder_id, label, valid_from, valid_until, max_uses, now) -> dict`, `delete_qr(conn, qr_id) -> None`, `update_qr_settings(conn, digit, max_active) -> None`.
  - `GET /api/qr-codes?holder_id=`; `POST /api/qr-codes` (`{holder_id, label, valid_from, valid_until, max_uses}`; fechas ISO 8601 con zona) → 201 con el QR y su `code`; `DELETE /api/qr-codes/{qr_id}` → 204.
  - `GET /api/qr-settings` → `{digit, max_active, editable}`; `PUT /api/qr-settings` (`{digit, max_active}`).
  - Errores: titular inexistente → el texto de `cards.py`; `valid_until <= valid_from` → 422 "La vigencia debe terminar después de empezar."; `max_uses` fuera de 1–100 y etiqueta > 60 → 422 de Pydantic en español; tope → 422 "Se alcanzó el máximo de QR vigentes de la instalación."; sin código libre → 503 "No se pudo generar un código de QR único."; tarjeta en rango (`create_card`/`update_card`) → 422 "Ese código está reservado para QR."; cambio de dígito con tarjetas en el nuevo rango → 422 "Hay tarjetas en ese rango"; vinculado → 409 "El panel está vinculado: el dígito de QR se cambia en la nube.".
  - Permisos: `qr_reader_mask: int = 0` (0–15) en entrada y salida.

- [ ] **Step 1: Escribir las pruebas que fallan**

```python
def test_create_qr_returns_code_in_range(client):
    r = client.post("/api/qr-codes", json={"holder_id": 1, "label": "Visita", "valid_from": "2026-12-01T09:00:00-06:00",
                                           "valid_until": "2026-12-01T18:00:00-06:00", "max_uses": 1})
    assert r.status_code == 201 and 900000000 <= r.json()["code"] <= 999999999
def test_qr_limit_422(client): ...         # max_active=1, segundo vigente → 422 texto fijo; uno vencido no cuenta
def test_qr_bad_validity_422(client): ...
def test_delete_qr_enqueues_delete(client, conn): ...
def test_card_in_qr_range_422(client): assert client.post("/api/cards", json={"card_code": 912345678, ...}).json() == {"detail": "Ese código está reservado para QR."}
def test_digit_change_with_cards_in_range_422(client): ...
def test_qr_settings_linked_409(client, conn): ...
def test_permission_qr_reader_mask_roundtrip(client): ...
```

- [ ] **Step 2: Correr y ver que fallan** — `.venv/bin/pytest tests/test_api_qr.py -q` → FAIL (404).
- [ ] **Step 3: Implementar** las rutas y registrarlas en `app.py`.
- [ ] **Step 4: Correr** — `.venv/bin/pytest -q` → PASS.
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 4: Frontend local (página QR, casillas por lector, ajustes, logs)

**Files:**
- Create: `panel/frontend/src/app/(panel)/qr/page.tsx` (+ `page.test.tsx`), `panel/frontend/src/components/QrForm.tsx`, `panel/frontend/src/components/QrImage.tsx` (+ tests), `panel/frontend/src/lib/qr.ts` (+ test)
- Modify: `panel/frontend/package.json` (`qrcode@1.5.4`, `@types/qrcode@1.5.5` exactos), `panel/frontend/src/app/(panel)/layout.tsx`, `panel/frontend/src/components/PermissionForm.tsx` (+ test), `panel/frontend/src/lib/types.ts`, `panel/frontend/src/lib/format.ts` (+ test), `panel/frontend/src/lib/masks.ts` (+ test), `panel/frontend/src/lib/time.ts` (+ test)

**Interfaces:**
- Consumes: rutas de la Tarea 3.
- Produces: menú "QR" después de "Tarjetas"; página con lista (anfitrión, etiqueta, vigencia en hora de México, usos máximos, estado Pendiente/Vigente/Vencido, usos por lector), alta (anfitrión, etiqueta, desde/hasta `datetime-local` en `America/Mexico_City`, usos 1–100), "Revocar" con confirmación, "Ver QR" (imagen, número debajo y botón "Descargar PNG" → `qr-<code>.png`) y bloque "Ajustes de QR" (Dígito de QR 1–9, Máximo de QR vigentes 1–100000; deshabilitado con aviso si `editable` es falso). `lib/qr.ts`: `qrDataUrl(code: number): Promise<string>`. `time.ts`: `mexicoLocalToIso(local: string): string` y `isoToMexicoLocal(iso: string): string`. `PermissionForm`: por lector L1–L4 tres casillas "Tarjeta", "PIN", "QR"; `masks.ts`: abreviatura de tabla `L1 T·P·Q` (solo las letras habilitadas). `format.ts`: `SOURCES[7] = "QR"`, `REASONS[14..17]` con los textos de Global Constraints.

- [ ] **Step 1: Pruebas que fallan (Vitest):** `QrForm` rechaza "hasta" anterior a "desde" con "La vigencia debe terminar después de empezar."; `mexicoLocalToIso("2026-12-01T09:00")` → `"2026-12-01T15:00:00.000Z"`; `QrImage` muestra el número y un enlace de descarga `qr-912345678.png`; `PermissionForm` envía `qr_reader_mask` con L2 marcado → 2; `format` traduce 7 y 14–17; la página deshabilita los ajustes con `editable: false`.
- [ ] **Step 2:** `cd panel/frontend && npm test` → FAIL.
- [ ] **Step 3: Implementar** con las skills `frontend-design` y `vercel-react-best-practices`, siguiendo `tarjetas/page.tsx` y `CardForm.tsx`.
- [ ] **Step 4:** `npm test && npm run lint && npm run build` → todo pasa.
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 5: Agente del panel (mapping, sync, `X-Acc-Schema: 9`)

**Files:**
- Modify: `panel/backend/acceso/cloud/mapping.py`, `panel/backend/acceso/cloud/sync.py`, `panel/backend/acceso/cloud/api.py` (si fija el valor; debe salir de `SCHEMA_VERSION`)
- Test: `panel/backend/tests/cloud/test_sync.py`, `panel/backend/tests/cloud/fake_cloud.py`, `panel/backend/tests/cloud/test_checksum.py`

**Interfaces:**
- Consumes: Tarea 1.
- Produces:
  - `FIELDS["qr_codes"] = ("holder_id", "code", "label", "valid_from", "valid_until", "max_uses", "created_at")` (holder por uuid; las tres fechas viajan como ISO con ms, convertidas con `iso_ms`/su inversa); `FIELDS["qr_settings"] = ("digit", "max_active")`; `FIELDS["permissions"]` agrega `qr_reader_mask`; `_OPTIONAL["permissions"]["qr_reader_mask"] = 0`.
  - `UPSERT_ORDER`: `qr_codes` después de `holders`, `qr_settings` al final; `DELETE_ORDER`: `qr_codes` antes de `holders`; `_CHILDREN["holders"]` incluye `qr_codes`.
  - `_upsert_qr_code` (libera un `code` ocupado por otro uuid con `_release`, como `_upsert_card`; conserva `qr_uses` si el uuid ya existía) y `_upsert_qr_settings` (siempre `id = 1`, adopta el uuid de la nube); `apply_delete("qr_settings", …)` no hace nada.
  - Reconciliación: `qr_codes` como `cards`; `qr_settings` como `call_settings` (solo toma valores de la nube; nunca se borra ni se sube); `snapshot_tables` no incluye `qr_settings` en la importación.
  - Todas las peticiones llevan `X-Acc-Schema: 9`.

- [ ] **Step 1: Pruebas que fallan:** `test_pull_applies_qr_upsert_and_delete` (el delete borra también `qr_uses`), `test_pull_qr_settings_adopts_cloud_uuid`, `test_pull_ignores_qr_settings_delete`, `test_push_qr_create_and_revoke`, `test_reconcile_qr_codes_by_checksum`, `test_qr_settings_never_pushed`, `test_requests_send_schema_header_9`.
- [ ] **Step 2:** `.venv/bin/pytest tests/cloud -q` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** `.venv/bin/pytest -q` → PASS.
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 6: Migración de la nube (`qr_codes`, ajustes de instalación, `qr_reader_mask`)

**Files:**
- Create: `cloud/supabase/migrations/<timestamp>_qr_codes.sql` (generar con `npx supabase migration new qr_codes`), `cloud/supabase/tests/qr_codes.test.sql`

**Interfaces:**
- Produces:
  - `public.qr_codes(id uuid, tenant_id, installation_id, holder_id, code bigint check 0–4294967295, label text default '' check length ≤ 60, valid_from timestamptz, valid_until timestamptz check (valid_until > valid_from), max_uses int default 1 check 1–100, created_at timestamptz default now(), updated_at, updated_by, origin, deleted_at, revision)`; FK `(installation_id, holder_id)` como `phones_holder_fkey`; índice único parcial `qr_codes_code_live_key (installation_id, code) where deleted_at is null`; índices como `phones`; triggers `before_write`, auditoría y `scrub_deleted_row` (`label := ''`); RLS y grants como `phones` para técnico+ (insert `(installation_id, holder_id, code, label, valid_from, valid_until, max_uses)`, update solo `(deleted_at)`); cascada lógica desde `holders` (redefinir `holders_soft_delete_cascade` agregando `qr_codes`).
  - Trigger `qr_codes_before_insert_limits` (`private.qr_codes_check_limits()`): candado `pg_advisory_xact_lock` por instalación; cuenta vivos con `valid_until > now()` ≥ `installations.qr_max_active` → `raise exception 'Se alcanzó el máximo de QR vigentes de la instalación.' using errcode = 'P0422'`; código igual a una tarjeta viva → `23505` con constraint `qr_codes_code_live_key`.
  - `installations.qr_digit`, `qr_max_active`, `qr_settings_revision` (ver decisiones); `public.set_installation_qr_settings(p_installation uuid, p_digit int, p_max_active int) returns void` (security definer, solo admin del tenant; tarjetas vivas en el nuevo rango → `'Hay tarjetas en ese rango'` `P0422`; sube la revisión con `private.bump_revision` y la guarda en `qr_settings_revision`).
  - `private.qr_range(p_digit int, out lo bigint, out hi bigint)` y trigger en `cards` (`cards_check_qr_range`, before insert or update of `card_code`) → `'Ese código está reservado para QR.'` `P0422` (también para el push del panel: queda como conflicto).
  - `profile_panel_rules.qr_reader_mask int not null default 0 check 0–15` (grants como `card_reader_mask`).
  - `private.expire_qr_codes()` y `cron.schedule('qr-codes-expire', …)` diario a la hora de `deleted-rows-purge` menos 10 minutos.
  - Redefiniciones completas desde su última versión en `20261125025657_phones_calls.sql` (solo cambia lo de QR): `private.push_row_base` (columnas de `qr_codes`), `private.push_permission_base` (`qr_reader_mask` opcional: se conserva si no viene, 0 al crear), `private.import_rows` (`qr_codes` si vienen; `qr_reader_mask` 0 si no viene), `public.apply_panel_change` (`'qr_codes'` por `push_row`; `'qr_settings'` → `'superseded'`), `private.unique_conflict_version` (rama `qr_codes_code_live_key`), `private.scrub_deleted_row`, `private.sync_conflict_scrub`, `private.purge_deleted_rows` (incluye `qr_codes`), `public.delete_installation` y los `check` de `audit_log`, `sync_conflicts` y `purged_rows`. Encabezado de comentarios como `phones_calls.sql`, con el orden de despliegue.

- [ ] **Step 1: pgTAP que falla** (`qr_codes.test.sql`): código único vivo (`23505`; tras borrar se permite); `valid_until <= valid_from` → `23514`; tope 2 con dos vigentes → `P0422` con el texto fijo, uno vencido no cuenta; tarjeta en rango → `P0422` "Ese código está reservado para QR."; `set_installation_qr_settings` con tarjeta viva en el rango nuevo → "Hay tarjetas en ese rango", técnico → `42501`, admin sube `qr_settings_revision`; RLS: otro tenant no ve, técnico inserta y borra, técnico no cambia `label`; borrar el titular borra lógicamente sus QR; `expire_qr_codes` marca solo los vencidos hace > 30 días y `purge_deleted_rows` deja lápida; `push_permission sin qr_reader_mask conserva el valor`.
- [ ] **Step 2:** `cd cloud && npx supabase db reset && npm run test:db` → FAIL en el archivo nuevo.
- [ ] **Step 3: Escribir la migración.**
- [ ] **Step 4:** `npm run test:db` → PASS (todas).
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 7: Feed, checksums, snapshot e importación para paneles v9

**Files:**
- Modify: `cloud/src/lib/device/contract.ts`, `cloud/src/lib/device/projection.ts`, `cloud/src/lib/device/changes.ts`, `cloud/src/lib/device/apply.ts`, `cloud/src/lib/device/imports.ts`, `cloud/src/lib/device/logs.ts` (aceptar origen 7 y motivos 14–17 si valida rangos)
- Test: los `*.test.ts` vecinos

**Interfaces:**
- Consumes: Tarea 6; `Panel.schema` de `auth.ts` (sin cambios).
- Produces:
  - `contract.ts`: `TABLES` agrega `"qr_codes", "qr_settings"`; `SCHEMA9_TABLES = new Set(["qr_codes", "qr_settings"])` y `tablesForSchema(schema)` las excluye si `schema < 9`; `dataSchemas.qr_codes = {holder_id: uuid, code: 0–4294967295, label: texto ≤ 60, valid_from, valid_until, created_at: ISO, max_uses: 1–100}`; `dataSchemas.qr_settings = {digit: 1–9, max_active: 1–100000}`; `permissions.qr_reader_mask: mascara4.optional()`.
  - `projection.ts`: `SourceTable` agrega `"qr_codes" | "installations"`; `projectQrCode(row: QrCodeRow): QrCodeData`; `projectQrSettings(row: InstallationQrRow): QrSettingsData`; `projectPermission` agrega `qr_reader_mask` solo si `panel.schema >= 9`.
  - `changes.ts`: `ORIGENES_PULL_V9 = [...ORIGENES_PULL, "qr_codes", "installations"]` para `panel.schema >= 9`; el origen `installations` se lee por `qr_settings_revision` y emite `qr_settings` upsert con `id` = instalación; checksums y snapshot por `tablesForSchema`.
  - `apply.ts`: el push de `qr_settings` responde `superseded` sin escribir.
  - `imports.ts`: el plan de un panel v9 lleva `qr_codes`; un panel v8 importa sin ellos.

- [ ] **Step 1: Pruebas que fallan (Vitest):** `listChanges omite qr_codes a panel v8`, `listChanges envía qr_codes a panel v9 en revisión`, `cambio de dígito emite qr_settings con la revisión`, `checksums de panel v9 incluyen qr_codes y qr_settings`, `permissions de panel v8 sin qr_reader_mask`, `push de qr_settings es superseded`, `importación de panel v9 con qr_codes`.
- [ ] **Step 2:** `cd cloud && npm test -- src/lib/device` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 8: Biblioteca de QR, API pública `/api/v1/.../qr-codes`, reglas y OpenAPI

**Files:**
- Create: `cloud/src/lib/qr-codes.ts`, `cloud/src/lib/api/qr-codes.ts`, `cloud/src/app/api/v1/installations/[installationId]/qr-codes/route.ts`, `.../qr-codes/[qrId]/route.ts` (+ tests)
- Modify: `cloud/src/lib/cards.ts` (mapear `P0422`), `cloud/src/lib/installations.ts`, `cloud/src/lib/profiles.ts`, `cloud/src/lib/api/profiles.ts`, `cloud/src/lib/api/openapi.ts`, `cloud/src/lib/api/docs.ts`, `cloud/docs/api.md`

**Interfaces:**
- Consumes: Tarea 6.
- Produces:
  - `lib/qr-codes.ts`: `QrCodeRow {id, holder_id, holder_name, code, label, valid_from, valid_until, max_uses, status, created_at, origin}`; `qrRange(digit: number): [number, number]`; `qrStatus(row, now: Date): "pending" | "active" | "expired"`; `listQrCodesAs(supabase, tenantId, installationId, filtro?: {holderId?, status?})`, `getQrCodeAs`, `createQrCodeAs(supabase, tenantId, installationId, input: {holder_id, label?, valid_from, valid_until, max_uses?})` (lee `qr_digit`, genera con `crypto.randomInt`, reintenta en `23505` hasta 20 → `HttpError(503, "No se pudo generar un código de QR único.")`), `deleteQrCodeAs`; `P0422` → `HttpError(422, <mensaje de la base>)`.
  - `lib/installations.ts`: `getQrSettingsAs(...)` → `{digit, max_active}` y `setQrSettingsAs(supabase, tenantId, installationId, {digit, max_active})` (RPC; admin).
  - Rutas: `POST` (201, `Idempotency-Key`), `GET` (`?holder_id=`, `?status=`), `GET /{qrId}`, `DELETE /{qrId}` (204); sin `PUT`/`PATCH` (405 por omisión de Next). Fechas: `z.string().datetime({ offset: true })`; sin zona → 400 "Las fechas deben llevar zona horaria (ISO 8601)."
  - Reglas de perfil: `qr_reader_mask` (0–15) en lectura y escritura.
  - OpenAPI: esquemas `QrCode`, `QrCodeCreate`, rutas nuevas, `qr_reader_mask`, origen 7 y motivos 14–17; `/docs/api` y `cloud/docs/api.md` con la sección "Códigos QR" (formato y dígito, usos por lector, vigencia con zona, riesgo de compartir la imagen).
  - **Decisión del dueño:** la API pública nunca devuelve imagen del QR, solo `code` (número); la app que la consume genera la imagen. La imagen solo existe en las interfaces web (nube y local).

- [ ] **Step 1: Pruebas que fallan:** `qrRange(4)` → `[4000000000, 4294967295]`; `crear QR devuelve code en rango del dígito`; `vigencia con zona horaria` (`"2026-12-01T09:00:00-06:00"` se guarda como `15:00Z`; sin zona → 400); `tope excedido → 422 con el texto fijo`; `colisión 23505 reintenta`; `GET ?status=active filtra`; `DELETE → 204 y GET → 404`; `PATCH → 405`; `tarjeta en rango → 422 "Ese código está reservado para QR."`; `reglas aceptan qr_reader_mask`; `openapi incluye /qr-codes`.
- [ ] **Step 2:** `npm test -- src/lib src/app/api/v1` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 9: UI de la nube (pestaña QR, ajustes, casillas por lector, logs)

**Files:**
- Create: `cloud/src/app/t/[tenant]/installations/[id]/qr/{page.tsx,actions.ts}`, `cloud/src/components/access/{QrCodesManager.tsx,QrCodeForm.tsx,QrImage.tsx,QrSettingsForm.tsx}` (+ tests), `cloud/src/lib/qr-image.ts`
- Modify: `cloud/package.json` (`qrcode@1.5.4`, `@types/qrcode@1.5.5`), `cloud/src/app/t/[tenant]/installations/[id]/layout.tsx`, `cloud/src/app/t/[tenant]/installations/[id]/page.tsx` (o la página de configuración donde vive el nombre: bloque "Ajustes de QR"), `cloud/src/components/access/ProfileRulesEditor.tsx`, `cloud/src/lib/profile-view.ts`, `cloud/src/lib/log-view.ts`

**Interfaces:**
- Consumes: Tarea 8.
- Produces: pestaña "QR" después de "Tarjetas" (lista con anfitrión, etiqueta, vigencia en hora de México, usos máximos y estado; alta; "Revocar"; "Ver QR" con imagen, número y "Descargar PNG") para admin y técnico; "Ajustes de QR" (Dígito de QR, Máximo de QR vigentes) editable solo por admin, de solo lectura para técnico; `ProfileRulesEditor` con casillas Tarjeta/PIN/QR por lector; `log-view.ts` con origen 7 y motivos 14–17.

- [ ] **Step 1: Pruebas que fallan (Vitest):** `QrCodeForm` valida vigencia y usos 1–100; `QrSettingsForm` deshabilitado para técnico y muestra el 422 "Hay tarjetas en ese rango"; `QrImage` enlaza `qr-<code>.png`; `ProfileRulesEditor` envía `qr_reader_mask`; `log-view` traduce 7 y 14–17.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implementar** con `frontend-design` y `vercel-react-best-practices`.
- [ ] **Step 4:** `npm test && npm run lint && npm run build` → PASS.
- [ ] **Step 5: Dejar los cambios sin confirmar (el dueño confirma)**

### Task 10: Documentación, orden de despliegue y verificación final

**Files:**
- Modify: `CLAUDE.md` (esquema v9, motivos 14–17, origen 7, estado y conteos de pruebas), `panel/README.md` (sección "Códigos QR": ZK-QR-500 en un lector Wiegand, casillas por lector, dígito, usos por lector, NTP, prueba manual), `cloud/docs/despliegue.md` (migración `qr_codes`, trabajo `qr-codes-expire`, orden de despliegue y reversión), `cloud/docs/api.md` (si la Tarea 8 no lo cerró)
- Test: `bash cloud/e2e/run_e2e.sh`

- [ ] **Step 1: Documentar** el orden: primero la nube (`db push --remote` y enseguida Vercel), después el paquete del panel v9; un panel v8 con la nube nueva ignora los QR; no se revierte la nube con paneles v9; volver a v8 exige restaurar `access_control_backup_v8.sqlite`. Riesgos: el QR se puede fotografiar y compartir; la vigencia depende del reloj (NTP).
- [ ] **Step 2: Verificación completa:** `cd panel/backend && .venv/bin/pytest`; `cd panel/frontend && npm test && npm run lint && npm run build`; `cd cloud && npm test && npm run test:db && npm run lint && npm run build`; `bash cloud/e2e/run_e2e.sh` → todo pasa. Actualizar los conteos en `CLAUDE.md`.
- [ ] **Step 3: Dejar los cambios sin confirmar (el dueño confirma)**
