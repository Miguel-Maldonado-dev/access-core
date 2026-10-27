"""Tarjetas de acceso."""
import sqlite3
from typing import List, Optional

from acceso.db import transaction
from acceso.store.errors import Conflict, Invalid, NotFound

_SELECT = (
    "SELECT c.card_code, c.holder_id, h.name AS holder_name, h.kind AS holder_kind,"
    " c.description FROM cards c JOIN holders h ON h.holder_id = c.holder_id"
)


def list_cards(conn: sqlite3.Connection, holder_id: Optional[int] = None) -> List[dict]:
    sql, params = _SELECT, []
    if holder_id is not None:
        sql += " WHERE c.holder_id = ?"
        params.append(holder_id)
    sql += " ORDER BY c.card_code"
    return [dict(r) for r in conn.execute(sql, params)]


def get_card(conn: sqlite3.Connection, card_code: int) -> dict:
    row = conn.execute(_SELECT + " WHERE c.card_code = ?", (card_code,)).fetchone()
    if row is None:
        raise NotFound("La tarjeta %s no existe." % card_code)
    return dict(row)


def _check_holder(conn: sqlite3.Connection, holder_id: int) -> None:
    if conn.execute("SELECT 1 FROM holders WHERE holder_id = ?", (holder_id,)).fetchone() is None:
        raise Invalid("El titular %s no existe." % holder_id)


def create_card(conn: sqlite3.Connection, card_code: int, holder_id: int, description: str) -> None:
    with transaction(conn):
        _check_holder(conn, holder_id)
        owner = conn.execute(
            "SELECT h.name FROM cards c JOIN holders h ON h.holder_id = c.holder_id"
            " WHERE c.card_code = ?",
            (card_code,),
        ).fetchone()
        if owner is not None:
            raise Conflict("La tarjeta %s ya está registrada a %s." % (card_code, owner["name"]))
        conn.execute(
            "INSERT INTO cards(card_code, holder_id, description) VALUES (?, ?, ?)",
            (card_code, holder_id, description),
        )


def update_card(conn: sqlite3.Connection, card_code: int, holder_id: int, description: str) -> None:
    with transaction(conn):
        if conn.execute("SELECT 1 FROM cards WHERE card_code = ?", (card_code,)).fetchone() is None:
            raise NotFound("La tarjeta %s no existe." % card_code)
        _check_holder(conn, holder_id)
        conn.execute(
            "UPDATE cards SET holder_id = ?, description = ? WHERE card_code = ?",
            (holder_id, description, card_code),
        )


def delete_card(conn: sqlite3.Connection, card_code: int) -> None:
    with transaction(conn):
        cur = conn.execute("DELETE FROM cards WHERE card_code = ?", (card_code,))
        if cur.rowcount == 0:
            raise NotFound("La tarjeta %s no existe." % card_code)
