"""Teléfonos de los titulares (apertura por llamada)."""
import sqlite3
import uuid
from typing import List, Optional

from acceso.db import now_ms, transaction
from acceso.store.errors import Conflict, Invalid, NotFound

_SELECT = (
    "SELECT p.phone_id, p.holder_id, h.name AS holder_name, p.number, p.description"
    " FROM phones p JOIN holders h ON h.holder_id = p.holder_id"
)
DUPLICATE_MESSAGE = "El número ya está registrado"


def list_phones(conn: sqlite3.Connection, holder_id: Optional[int] = None) -> List[dict]:
    sql, params = _SELECT, []
    if holder_id is not None:
        sql += " WHERE p.holder_id = ?"
        params.append(holder_id)
    sql += " ORDER BY p.phone_id"
    return [dict(r) for r in conn.execute(sql, params)]


def get_phone(conn: sqlite3.Connection, phone_id: int) -> dict:
    row = conn.execute(_SELECT + " WHERE p.phone_id = ?", (phone_id,)).fetchone()
    if row is None:
        raise NotFound("El teléfono %s no existe." % phone_id)
    return dict(row)


def _check_holder(conn: sqlite3.Connection, holder_id: int) -> None:
    if conn.execute("SELECT 1 FROM holders WHERE holder_id = ?", (holder_id,)).fetchone() is None:
        raise Invalid("El titular %s no existe." % holder_id)


def _check_free(conn: sqlite3.Connection, number: str, own_id: Optional[int]) -> None:
    row = conn.execute("SELECT phone_id FROM phones WHERE number = ?", (number,)).fetchone()
    if row is not None and row["phone_id"] != own_id:
        raise Conflict(DUPLICATE_MESSAGE)


def create_phone(conn: sqlite3.Connection, holder_id: int, number: str, description: str) -> int:
    with transaction(conn):
        _check_holder(conn, holder_id)
        _check_free(conn, number, None)
        cur = conn.execute(
            "INSERT INTO phones(holder_id, number, description, uuid, updated_at, origin)"
            " VALUES (?, ?, ?, ?, ?, 'local')",
            (holder_id, number, description, str(uuid.uuid4()), now_ms()))
        return cur.lastrowid


def update_phone(conn: sqlite3.Connection, phone_id: int, holder_id: int, number: str,
                 description: str) -> None:
    with transaction(conn):
        if conn.execute("SELECT 1 FROM phones WHERE phone_id = ?", (phone_id,)).fetchone() is None:
            raise NotFound("El teléfono %s no existe." % phone_id)
        _check_holder(conn, holder_id)
        _check_free(conn, number, phone_id)
        conn.execute(
            "UPDATE phones SET holder_id = ?, number = ?, description = ?, updated_at = ?,"
            " origin = 'local' WHERE phone_id = ?",
            (holder_id, number, description, now_ms(), phone_id))


def delete_phone(conn: sqlite3.Connection, phone_id: int) -> None:
    with transaction(conn):
        cur = conn.execute("DELETE FROM phones WHERE phone_id = ?", (phone_id,))
        if cur.rowcount == 0:
            raise NotFound("El teléfono %s no existe." % phone_id)
