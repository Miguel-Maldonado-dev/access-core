import sqlite3

from .constants import SCHEMA_VERSION

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS holders (holder_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('persona','domicilio')), name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  department TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  pin TEXT CHECK(pin IS NULL OR (length(pin) BETWEEN 4 AND 6 AND pin NOT GLOB '*[^0-9]*')));
CREATE TABLE IF NOT EXISTS permissions (permission_id INTEGER PRIMARY KEY CHECK(permission_id BETWEEN 0 AND 31),
  name TEXT NOT NULL, output_mask INTEGER NOT NULL CHECK(output_mask BETWEEN 0 AND 15),
  reader_mask INTEGER NOT NULL CHECK(reader_mask BETWEEN 0 AND 15), weekday_mask INTEGER NOT NULL CHECK(weekday_mask BETWEEN 0 AND 127),
  start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439), end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 0 AND 1439),
  allow_pin INTEGER NOT NULL DEFAULT 0 CHECK(allow_pin IN (0,1)));
CREATE TABLE IF NOT EXISTS holder_permissions (
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE, PRIMARY KEY(holder_id, permission_id));
CREATE TABLE IF NOT EXISTS outputs (output_id INTEGER PRIMARY KEY CHECK(output_id BETWEEN 0 AND 3),
  duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 65535),
  reader_mask INTEGER NOT NULL CHECK(reader_mask BETWEEN 0 AND 15), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
CREATE TABLE IF NOT EXISTS cards (card_code INTEGER PRIMARY KEY CHECK(card_code BETWEEN 0 AND 4294967295),
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS controls (control_id INTEGER PRIMARY KEY,
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS control_buttons (
  control_id INTEGER NOT NULL REFERENCES controls(control_id) ON DELETE CASCADE,
  button INTEGER NOT NULL CHECK(button BETWEEN 0 AND 3),
  rf_code INTEGER NOT NULL UNIQUE CHECK(rf_code BETWEEN 0 AND 4294967295),
  output_id INTEGER REFERENCES outputs(output_id), PRIMARY KEY(control_id, button));
CREATE TABLE IF NOT EXISTS access_logs (log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL, allowed INTEGER NOT NULL, source INTEGER NOT NULL,
  holder_id INTEGER REFERENCES holders(holder_id) ON DELETE SET NULL, holder_name TEXT, holder_kind TEXT,
  credential_label TEXT, control_id INTEGER REFERENCES controls(control_id) ON DELETE SET NULL,
  code INTEGER, device_id INTEGER, output_id INTEGER, reason INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS access_logs_timestamp ON access_logs(timestamp);
CREATE INDEX IF NOT EXISTS access_logs_holder ON access_logs(holder_id);
CREATE UNIQUE INDEX IF NOT EXISTS holders_pin ON holders(pin);
"""

DEFAULT_OUTPUTS = ((0, 3000, 3, 1), (1, 3000, 12, 1), (2, 3000, 0, 1), (3, 3000, 0, 1))
DEFAULT_PERMISSION = (0, "Acceso total", 15, 15, 127, 0, 0)


def create_schema(conn: sqlite3.Connection) -> None:
    """Crea el esquema v4 y los valores por defecto; es idempotente."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        for statement in SCHEMA_SQL.split(";\n"):
            if statement.strip():
                conn.execute(statement)
        conn.executemany(
            "INSERT OR IGNORE INTO outputs(output_id, duration_ms, reader_mask, enabled)"
            " VALUES (?, ?, ?, ?)",
            DEFAULT_OUTPUTS,
        )
        if conn.execute("SELECT COUNT(*) FROM permissions").fetchone()[0] == 0:
            conn.execute(
                "INSERT INTO permissions(permission_id, name, output_mask, reader_mask,"
                " weekday_mask, start_minute, end_minute) VALUES (?, ?, ?, ?, ?, ?, ?)",
                DEFAULT_PERMISSION,
            )
        conn.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")
