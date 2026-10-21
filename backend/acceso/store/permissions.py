"""Permisos (ids 0..31)."""
import sqlite3
from typing import List

from acceso.db import transaction
from acceso.store.errors import Conflict, NotFound

_COLS = ("permission_id", "name", "output_mask", "card_reader_mask", "pin_reader_mask", "weekday_mask",
         "start_minute", "end_minute", "allow_rf")


def list_permissions(conn: sqlite3.Connection) -> List[dict]:
    rows = conn.execute("SELECT %s FROM permissions ORDER BY permission_id" % ", ".join(_COLS))
    return [{**dict(r), "allow_rf": bool(r["allow_rf"])} for r in rows]


def create_permission(conn: sqlite3.Connection, p: dict) -> None:
    with transaction(conn):
        if conn.execute(
            "SELECT 1 FROM permissions WHERE permission_id = ?", (p["permission_id"],)
        ).fetchone():
            raise Conflict("Ya existe el permiso %s." % p["permission_id"])
        conn.execute(
            "INSERT INTO permissions(%s) VALUES (%s)" % (", ".join(_COLS), ", ".join("?" * len(_COLS))),
            tuple(int(bool(p[c])) if c == "allow_rf" else p[c] for c in _COLS),
        )


def update_permission(conn: sqlite3.Connection, permission_id: int, p: dict) -> None:
    """Un campo de método (máscaras de lector, allow_rf) en None conserva el valor actual."""
    allow_rf = p.get("allow_rf")
    with transaction(conn):
        cur = conn.execute(
            "UPDATE permissions SET name=?, output_mask=?, card_reader_mask=COALESCE(?, card_reader_mask),"
            " pin_reader_mask=COALESCE(?, pin_reader_mask), weekday_mask=?, start_minute=?,"
            " end_minute=?, allow_rf=COALESCE(?, allow_rf) WHERE permission_id=?",
            (p["name"], p["output_mask"], p.get("card_reader_mask"), p.get("pin_reader_mask"),
             p["weekday_mask"], p["start_minute"], p["end_minute"],
             None if allow_rf is None else int(allow_rf), permission_id),
        )
        if cur.rowcount == 0:
            raise NotFound("El permiso %s no existe." % permission_id)


def delete_permission(conn: sqlite3.Connection, permission_id: int) -> None:
    with transaction(conn):
        cur = conn.execute("DELETE FROM permissions WHERE permission_id = ?", (permission_id,))
        if cur.rowcount == 0:
            raise NotFound("El permiso %s no existe." % permission_id)
