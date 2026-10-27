"""Migración de la base v2 (Tkinter), v3 y v4 al esquema v5 del panel web."""
import fcntl
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from .constants import SCHEMA_VERSION
from .db import connect, transaction
from .schema import SCHEMA_SQL, create_schema

V1_MESSAGE = "Base v1 no soportada: ábrela primero con access_control_admin_gui.py"
LEGACY_TABLES = ("users", "user_permissions", "permissions", "outputs", "cards",
                 "controls", "control_buttons", "access_logs")

_CREATE_TABLE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+)")
_CREATE_TABLE_V3 = re.compile(r"CREATE TABLE (\w+)_v3")
_REFERENCES = re.compile(r"REFERENCES (\w+)\(")

_COPY_SQL = (
    "INSERT INTO holders_v3(holder_id, kind, name, department, address, notes)"
    " SELECT user_id, 'persona', name, department, address, '' FROM users",
    "INSERT INTO permissions_v3(permission_id, name, output_mask, card_reader_mask,"
    " pin_reader_mask, weekday_mask, start_minute, end_minute, allow_rf)"
    " SELECT permission_id, name, output_mask & 15, reader_mask & 15, 0,"
    " weekday_mask & 127, start_minute, end_minute, 1 FROM permissions",
    "INSERT INTO holder_permissions_v3(holder_id, permission_id)"
    " SELECT user_id, permission_id FROM user_permissions",
    "INSERT INTO outputs_v3 SELECT output_id, duration_ms, reader_mask & 15, enabled != 0"
    " FROM outputs WHERE output_id BETWEEN 0 AND 3",
    "INSERT INTO cards_v3(card_code, holder_id, description)"
    " SELECT card_code, user_id, description FROM cards",
    "INSERT INTO controls_v3(control_id, holder_id, description)"
    " SELECT control_id, user_id, description FROM controls",
    "INSERT INTO control_buttons_v3(control_id, button, rf_code, output_id)"
    " SELECT control_id, button, rf_code,"
    " CASE WHEN output_id BETWEEN 0 AND 3 THEN output_id END FROM control_buttons",
    "INSERT INTO access_logs_v3(log_id, timestamp, allowed, source, holder_id, holder_name,"
    " holder_kind, credential_label, control_id, code, device_id, output_id, reason)"
    " SELECT l.log_id, l.timestamp, l.allowed, l.source, u.user_id, u.name,"
    " CASE WHEN u.user_id IS NOT NULL THEN 'persona' END,"
    " CASE l.source"
    "  WHEN 0 THEN (SELECT NULLIF(c.description, '') FROM cards c WHERE c.card_code = l.code)"
    "  WHEN 1 THEN (SELECT NULLIF(k.description, '') FROM controls k WHERE k.control_id = l.control_id)"
    " END,"
    " l.control_id, l.code, l.device_id, l.output_id, l.reason"
    " FROM access_logs l LEFT JOIN users u ON u.user_id = l.user_id ORDER BY l.log_id",
)


# v3 -> v4: misma definición de columna que SCHEMA_SQL (el test de esquemas idénticos vigila
# que no se desvíe); el índice único se toma de SCHEMA_SQL. La columna allow_pin de permissions
# ya no existe en v5: _rebuild_permissions la convierte.
_V4_ALTERS = (
    "ALTER TABLE holders ADD COLUMN pin TEXT"
    " CHECK(pin IS NULL OR (length(pin) BETWEEN 4 AND 6 AND pin NOT GLOB '*[^0-9]*'))",
    "ALTER TABLE permissions ADD COLUMN allow_pin INTEGER NOT NULL DEFAULT 0"
    " CHECK(allow_pin IN (0,1))",
)


MAX_DATED_BACKUPS = 3


class MigrationError(Exception):
    """La base no se puede migrar."""


@dataclass(frozen=True)
class MigrationResult:
    from_version: int
    to_version: int
    backup_path: Optional[Path]


def _schema_statements() -> List[str]:
    return [s.strip() for s in SCHEMA_SQL.split(";\n") if s.strip()]


def _v3_table_statements() -> List[str]:
    """Las tablas de SCHEMA_SQL con sufijo _v3 (y sus referencias), para convivir con las viejas."""
    result = []
    for statement in _schema_statements():
        match = _CREATE_TABLE.match(statement)
        if match:
            statement = _CREATE_TABLE.sub("CREATE TABLE %s_v3" % match.group(1), statement, count=1)
            result.append(_REFERENCES.sub(lambda m: "REFERENCES %s_v3(" % m.group(1), statement))
    return result


def _index_statements() -> List[str]:
    return [s for s in _schema_statements()
            if s.startswith(("CREATE INDEX", "CREATE UNIQUE INDEX"))]


def _unique_index_statements() -> List[str]:
    return [s for s in _schema_statements() if s.startswith("CREATE UNIQUE INDEX")]


def _tables(conn: sqlite3.Connection) -> List[str]:
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]


def _detect_version(conn: sqlite3.Connection) -> int:
    tables = _tables(conn)
    if not tables:
        return 0
    user_version = conn.execute("PRAGMA user_version").fetchone()[0]
    if user_version == SCHEMA_VERSION:
        return SCHEMA_VERSION
    if user_version in (3, 4) and "holders" in tables:
        return user_version
    if "users" in tables:
        columns = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
        if "card_code" in columns:
            raise MigrationError(V1_MESSAGE)
        if "cards" in tables:
            return 2
    raise MigrationError("Base con esquema desconocido; no se migra")


def _backup(conn: sqlite3.Connection, db_path: Path, version: int) -> Path:
    """Respalda a un .tmp y lo publica con os.replace; un respaldo previo se conserva con fecha."""
    backup_path = db_path.with_name("%s_backup_v%d.sqlite" % (db_path.stem, version))
    tmp_path = backup_path.with_name(backup_path.name + ".tmp")
    if tmp_path.exists():
        tmp_path.unlink()
    target = sqlite3.connect(str(tmp_path))
    try:
        conn.backup(target)
    finally:
        target.close()
    os.chmod(str(tmp_path), 0o600)  # la base guarda PIN en texto plano
    if backup_path.exists():
        stamp = datetime.fromtimestamp(backup_path.stat().st_mtime).strftime("%Y%m%d-%H%M%S")
        os.replace(str(backup_path), str(backup_path.with_name(
            "%s_backup_v%d.%s.sqlite" % (db_path.stem, version, stamp))))
    os.replace(str(tmp_path), str(backup_path))
    _prune_backups(db_path, version)
    return backup_path


def _prune_backups(db_path: Path, version: int) -> None:
    """Conserva solo las MAX_DATED_BACKUPS copias con fecha más recientes de esa versión."""
    dated = sorted(
        db_path.parent.glob("%s_backup_v%d.*.sqlite" % (db_path.stem, version)),
        key=lambda p: (p.stat().st_mtime, p.name),
    )
    for old in dated[:-MAX_DATED_BACKUPS]:
        old.unlink()


def _convert_v2(conn: sqlite3.Connection) -> None:
    # foreign_keys no se puede cambiar dentro de una transaccion.
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        with transaction(conn):
            for statement in _v3_table_statements():
                conn.execute(statement)
            for statement in _COPY_SQL:
                conn.execute(statement)
            for table in LEGACY_TABLES:
                conn.execute("DROP TABLE %s" % table)
            for statement in _v3_table_statements():
                name = _CREATE_TABLE_V3.match(statement).group(1)
                conn.execute("ALTER TABLE %s_v3 RENAME TO %s" % (name, name))
            for statement in _index_statements():
                conn.execute(statement)
            conn.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)
    finally:
        conn.execute("PRAGMA foreign_keys=ON")


def _permissions_v5_statement() -> str:
    for statement in _schema_statements():
        if statement.startswith("CREATE TABLE IF NOT EXISTS permissions "):
            return statement.replace("CREATE TABLE IF NOT EXISTS permissions ",
                                     "CREATE TABLE permissions_v5 ", 1)
    raise MigrationError("SCHEMA_SQL sin tabla permissions")


def _rebuild_permissions(conn: sqlite3.Connection) -> None:
    """Reconstruye permissions al formato v5 dentro de la transacción actual.

    Requiere foreign_keys=OFF (si no, el DROP borraría holder_permissions en cascada).
    reader_mask -> card_reader_mask; pin_reader_mask = reader_mask si allow_pin=1, si no 0;
    allow_rf = 1 (hoy el control RF pasa con cualquier permiso que cubra la salida).
    """
    columns = [r[1] for r in conn.execute("PRAGMA table_info(permissions)")]
    pin_expr = "CASE WHEN allow_pin = 1 THEN reader_mask ELSE 0 END" if "allow_pin" in columns else "0"
    conn.execute(_permissions_v5_statement())
    conn.execute(
        "INSERT INTO permissions_v5(permission_id, name, output_mask, card_reader_mask,"
        " pin_reader_mask, weekday_mask, start_minute, end_minute, allow_rf)"
        " SELECT permission_id, name, output_mask, reader_mask, %s, weekday_mask,"
        " start_minute, end_minute, 1 FROM permissions" % pin_expr)
    conn.execute("DROP TABLE permissions")
    conn.execute("ALTER TABLE permissions_v5 RENAME TO permissions")


def _holder_permission_orphans(conn: sqlite3.Connection) -> set:
    return {(r[1], r[2], r[3]) for r in conn.execute("PRAGMA foreign_key_check(holder_permissions)")}


def _convert_v3_or_v4(conn: sqlite3.Connection, version: int) -> None:
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        with transaction(conn):
            if version == 3:
                for statement in _V4_ALTERS:
                    conn.execute(statement)
                for statement in _unique_index_statements():
                    conn.execute(statement)
            # Huérfanos previos (p. ej. de una importación con FK apagadas) se conservan;
            # solo aborta lo que la reconstrucción introduzca.
            orphans_before = _holder_permission_orphans(conn)
            _rebuild_permissions(conn)
            if _holder_permission_orphans(conn) - orphans_before:
                raise sqlite3.IntegrityError("foreign_key_check falló tras reconstruir permissions")
            conn.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)
    finally:
        conn.execute("PRAGMA foreign_keys=ON")


def migrate(db_path: Path) -> MigrationResult:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = db_path.with_name(db_path.name + ".lock")
    with open(str(lock_path), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        conn = connect(db_path)
        try:
            version = _detect_version(conn)
            if version == SCHEMA_VERSION:
                return MigrationResult(SCHEMA_VERSION, SCHEMA_VERSION, None)
            if version == 0:
                create_schema(conn)
                return MigrationResult(0, SCHEMA_VERSION, None)
            # v2 se convierte directo a las tablas v5 con el respaldo v2; v3 y v4 agregan lo que
            # falta y reconstruyen permissions, cada una con su respaldo de la versión de origen.
            try:
                backup_path = _backup(conn, db_path, version)
                if version == 2:
                    _convert_v2(conn)
                else:
                    _convert_v3_or_v4(conn, version)
            except (sqlite3.Error, OSError) as exc:
                raise MigrationError(
                    "No se pudo migrar la base (sigue en v%d): %s" % (version, exc)) from exc
            return MigrationResult(version, SCHEMA_VERSION, backup_path)
        finally:
            conn.close()


def main() -> int:
    from .config import ConfigError, load_settings

    try:
        settings = load_settings()
        result = migrate(settings.db_path)
    except (ConfigError, MigrationError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if result.backup_path is None:
        print("La base ya está en v%d." % result.to_version)
    else:
        print("Migrada de v%d a v%d. Respaldo: %s"
              % (result.from_version, result.to_version, result.backup_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
