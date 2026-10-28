"""Salidas (relevadores 0..3)."""
import sqlite3
from typing import List, Optional

from acceso.db import now_ms, transaction
from acceso.store.errors import NotFound


def _row(r) -> dict:
    d = dict(r)
    d["enabled"] = bool(d["enabled"])
    return d


def list_outputs(conn: sqlite3.Connection) -> List[dict]:
    rows = conn.execute(
        "SELECT output_id, duration_ms, reader_mask, enabled, alias FROM outputs ORDER BY output_id"
    )
    return [_row(r) for r in rows]


def update_output(conn: sqlite3.Connection, output_id: int, duration_ms: int,
                  reader_mask: int, enabled: bool, alias: Optional[str] = None) -> None:
    """alias en None conserva el actual (una pestaña vieja no lo borra)."""
    with transaction(conn):
        cur = conn.execute(
            "UPDATE outputs SET duration_ms=?, reader_mask=?, enabled=?, alias=COALESCE(?, alias),"
            " updated_at=?, origin='local' WHERE output_id=?",
            (duration_ms, reader_mask, 1 if enabled else 0, alias, now_ms(), output_id),
        )
        if cur.rowcount == 0:
            raise NotFound("La salida %s no existe." % output_id)
