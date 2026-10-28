import sqlite3
import uuid

from .constants import REPLICATED_TABLES, SCHEMA_VERSION
from .db import now_ms

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS holders (holder_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('persona','domicilio')), name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  department TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  pin TEXT CHECK(pin IS NULL OR (length(pin) BETWEEN 4 AND 6 AND pin NOT GLOB '*[^0-9]*')),
  uuid TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'local');
CREATE TABLE IF NOT EXISTS permissions (permission_id INTEGER PRIMARY KEY CHECK(permission_id BETWEEN 0 AND 31),
  name TEXT NOT NULL, output_mask INTEGER NOT NULL CHECK(output_mask BETWEEN 0 AND 15),
  card_reader_mask INTEGER NOT NULL CHECK(card_reader_mask BETWEEN 0 AND 15),
  pin_reader_mask INTEGER NOT NULL CHECK(pin_reader_mask BETWEEN 0 AND 15),
  weekday_mask INTEGER NOT NULL CHECK(weekday_mask BETWEEN 0 AND 127),
  start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439), end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 0 AND 1439),
  allow_rf INTEGER NOT NULL DEFAULT 0 CHECK(allow_rf IN (0,1)),
  uuid TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'local');
CREATE TABLE IF NOT EXISTS holder_permissions (
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
  uuid TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY(holder_id, permission_id));
CREATE TABLE IF NOT EXISTS outputs (output_id INTEGER PRIMARY KEY CHECK(output_id BETWEEN 0 AND 3),
  duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 65535),
  reader_mask INTEGER NOT NULL CHECK(reader_mask BETWEEN 0 AND 15), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  alias TEXT NOT NULL DEFAULT '',
  uuid TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'local');
CREATE TABLE IF NOT EXISTS cards (card_code INTEGER PRIMARY KEY CHECK(card_code BETWEEN 0 AND 4294967295),
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE, description TEXT NOT NULL DEFAULT '',
  uuid TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'local');
CREATE TABLE IF NOT EXISTS controls (control_id INTEGER PRIMARY KEY,
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE, description TEXT NOT NULL DEFAULT '',
  uuid TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'local');
CREATE TABLE IF NOT EXISTS control_buttons (
  control_id INTEGER NOT NULL REFERENCES controls(control_id) ON DELETE CASCADE,
  button INTEGER NOT NULL CHECK(button BETWEEN 0 AND 3),
  rf_code INTEGER NOT NULL UNIQUE CHECK(rf_code BETWEEN 0 AND 4294967295),
  output_id INTEGER REFERENCES outputs(output_id),
  uuid TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY(control_id, button));
CREATE TABLE IF NOT EXISTS access_logs (log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL, allowed INTEGER NOT NULL, source INTEGER NOT NULL,
  holder_id INTEGER REFERENCES holders(holder_id) ON DELETE SET NULL, holder_name TEXT, holder_kind TEXT,
  credential_label TEXT, control_id INTEGER REFERENCES controls(control_id) ON DELETE SET NULL,
  code INTEGER, device_id INTEGER, output_id INTEGER, reason INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS access_logs_timestamp ON access_logs(timestamp);
CREATE INDEX IF NOT EXISTS access_logs_holder ON access_logs(holder_id);
CREATE UNIQUE INDEX IF NOT EXISTS holders_pin ON holders(pin);
CREATE TABLE IF NOT EXISTS sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE, table_name TEXT NOT NULL,
  op TEXT NOT NULL CHECK(op IN ('upsert','delete')), row_uuid TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_guard (id INTEGER PRIMARY KEY CHECK(id=1), applying INTEGER NOT NULL DEFAULT 0);
"""

# Hora actual en ms, calculada en SQL para los borrados (el registro ya no existe).
_NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"


def _trigger(table: str, suffix: str, event: str, op: str, row: str, stamp: str) -> str:
    # Una sola línea, sin ';' seguido de salto de línea: create_schema parte por ';\n'.
    return (
        "CREATE TRIGGER IF NOT EXISTS %(t)s_sync_%(s)s AFTER %(e)s ON %(t)s"
        " WHEN (SELECT applying FROM sync_guard WHERE id=1)=0"
        " BEGIN INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
        " VALUES (lower(hex(randomblob(16))), '%(t)s', '%(o)s', %(r)s.uuid, %(u)s); END"
        % {"t": table, "s": suffix, "e": event, "o": op, "r": row, "u": stamp}
    )


def _sync_triggers() -> tuple:
    """Triggers que anotan en sync_outbox cada alta, cambio y baja (también las de cascada).

    Con sync_guard.applying=1 (el agente aplicando cambios de la nube) no anotan nada. El payload
    no se guarda: el agente lee la fila al enviar.
    """
    statements = []
    for table in REPLICATED_TABLES:
        statements.append(_trigger(table, "ins", "INSERT", "upsert", "NEW", "NEW.updated_at"))
        statements.append(_trigger(table, "upd", "UPDATE", "upsert", "NEW", "NEW.updated_at"))
        statements.append(_trigger(table, "del", "DELETE", "delete", "OLD", _NOW_MS_SQL))
    return tuple(statements)


TRIGGER_STATEMENTS = _sync_triggers()

DEFAULT_OUTPUTS = ((0, 3000, 3, 1), (1, 3000, 12, 1), (2, 3000, 0, 1), (3, 3000, 0, 1))
# (id, nombre, salidas, lectores tarjeta, lectores PIN, días, inicio, fin, RF)
DEFAULT_PERMISSION = (0, "Acceso total", 15, 15, 0, 127, 0, 0, 1)


def create_schema(conn: sqlite3.Connection) -> None:
    """Crea el esquema v6 y los valores por defecto; es idempotente.

    Los valores por defecto se insertan antes de crear los triggers: una base nueva empieza con
    la bandeja vacía (el alta inicial en la nube va por la importación del panel).
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        for statement in SCHEMA_SQL.split(";\n"):
            if statement.strip():
                conn.execute(statement)
        conn.execute("INSERT OR IGNORE INTO sync_guard(id, applying) VALUES (1, 0)")
        stamp = now_ms()
        conn.executemany(
            "INSERT OR IGNORE INTO outputs(output_id, duration_ms, reader_mask, enabled,"
            " uuid, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [row + (str(uuid.uuid4()), stamp) for row in DEFAULT_OUTPUTS],
        )
        if conn.execute("SELECT COUNT(*) FROM permissions").fetchone()[0] == 0:
            conn.execute(
                "INSERT INTO permissions(permission_id, name, output_mask,"
                " card_reader_mask, pin_reader_mask, weekday_mask, start_minute, end_minute,"
                " allow_rf, uuid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                DEFAULT_PERMISSION + (str(uuid.uuid4()), stamp),
            )
        for statement in TRIGGER_STATEMENTS:
            conn.execute(statement)
        conn.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
