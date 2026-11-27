"""Códigos QR de acceso (fechas en segundos UTC) y ajustes de QR."""
import sqlite3
import uuid
from typing import List, Optional

from acceso.db import now_ms, transaction
from acceso.qr import QrCodeExhausted, generate_code, get_qr_settings, qr_range
from acceso.store.errors import Conflict, Invalid, NotFound

LIMIT_MESSAGE = "Se alcanzó el máximo de QR vigentes de la instalación."
EXHAUSTED_MESSAGE = "No se pudo generar un código de QR único."
LINKED_MESSAGE = "El panel está vinculado: el dígito de QR se cambia en la nube."
CARDS_IN_RANGE_MESSAGE = "Hay tarjetas en ese rango de códigos; elimínalas o elige otro dígito."

_SELECT = (
    "SELECT q.qr_id, q.holder_id, h.name AS holder_name, q.code, q.label, q.valid_from,"
    " q.valid_until, q.max_uses FROM qr_codes q JOIN holders h ON h.holder_id = q.holder_id"
)


class QrUnavailable(Exception):
    """No hay código libre (la ruta responde 503)."""


def _status(row: dict, now: int) -> str:
    if now < row["valid_from"]:
        return "pending"
    return "active" if now < row["valid_until"] else "expired"


def _decorate(conn: sqlite3.Connection, rows: List[dict], now: int) -> List[dict]:
    for row in rows:
        row["status"] = _status(row, now)
        row["uses"] = {
            r["reader"]: r["count"]
            for r in conn.execute("SELECT reader, count FROM qr_uses WHERE qr_id = ? AND count > 0"
                                  " ORDER BY reader", (row["qr_id"],))
        }
    return rows


def list_qr(conn: sqlite3.Connection, holder_id: Optional[int], now: int) -> List[dict]:
    sql, params = _SELECT, []
    if holder_id is not None:
        sql += " WHERE q.holder_id = ?"
        params.append(holder_id)
    sql += " ORDER BY q.valid_until DESC, q.qr_id DESC"
    return _decorate(conn, [dict(r) for r in conn.execute(sql, params)], now)


def create_qr(conn: sqlite3.Connection, holder_id: int, label: str, valid_from: int,
              valid_until: int, max_uses: int, now: int) -> dict:
    with transaction(conn):
        if conn.execute("SELECT 1 FROM holders WHERE holder_id = ?", (holder_id,)).fetchone() is None:
            raise Invalid("El titular %s no existe." % holder_id)
        settings = get_qr_settings(conn)
        active = conn.execute("SELECT COUNT(*) FROM qr_codes WHERE valid_until > ?", (now,)).fetchone()[0]
        if active >= settings.max_active:
            raise Invalid(LIMIT_MESSAGE)
        try:
            code = generate_code(conn, settings.digit)
        except QrCodeExhausted:
            raise QrUnavailable(EXHAUSTED_MESSAGE)
        cur = conn.execute(
            "INSERT INTO qr_codes(holder_id, code, label, valid_from, valid_until, max_uses,"
            " created_at, uuid, updated_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')",
            (holder_id, code, label, valid_from, valid_until, max_uses, now, str(uuid.uuid4()), now_ms()),
        )
        qr_id = cur.lastrowid
    return _decorate(conn, [dict(conn.execute(_SELECT + " WHERE q.qr_id = ?", (qr_id,)).fetchone())], now)[0]


def delete_qr(conn: sqlite3.Connection, qr_id: int) -> None:
    with transaction(conn):
        cur = conn.execute("DELETE FROM qr_codes WHERE qr_id = ?", (qr_id,))
        if cur.rowcount == 0:
            raise NotFound("El código QR %s no existe." % qr_id)


def is_linked(conn: sqlite3.Connection) -> bool:
    """El panel ya se reclamó en la nube (cualquier estado distinto de 'unlinked')."""
    row = conn.execute("SELECT value FROM sync_state WHERE key = 'state'").fetchone()
    return row is not None and row[0] != "unlinked"


def update_qr_settings(conn: sqlite3.Connection, digit: int, max_active: int) -> None:
    with transaction(conn):
        if is_linked(conn):
            raise Conflict(LINKED_MESSAGE)
        low, high = qr_range(digit)
        if digit != get_qr_settings(conn).digit and conn.execute("SELECT 1 FROM cards WHERE card_code BETWEEN ? AND ? LIMIT 1",
                        (low, high)).fetchone() is not None:
            raise Invalid(CARDS_IN_RANGE_MESSAGE)
        conn.execute("UPDATE qr_settings SET digit = ?, max_active = ? WHERE id = 1", (digit, max_active))
