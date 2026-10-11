"""Salidas (relevadores 0..3)."""
import sqlite3
from typing import List

from acceso.db import transaction
from acceso.store.errors import NotFound


def _row(r) -> dict:
    d = dict(r)
    d["enabled"] = bool(d["enabled"])
    return d


def list_outputs(conn: sqlite3.Connection) -> List[dict]:
    rows = conn.execute(
        "SELECT output_id, duration_ms, reader_mask, enabled FROM outputs ORDER BY output_id"
    )
    return [_row(r) for r in rows]


def update_output(conn: sqlite3.Connection, output_id: int, duration_ms: int,
                  reader_mask: int, enabled: bool) -> None:
    with transaction(conn):
        cur = conn.execute(
            "UPDATE outputs SET duration_ms=?, reader_mask=?, enabled=? WHERE output_id=?",
            (duration_ms, reader_mask, 1 if enabled else 0, output_id),
        )
        if cur.rowcount == 0:
            raise NotFound("La salida %s no existe." % output_id)
