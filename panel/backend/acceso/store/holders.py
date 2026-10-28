"""Titulares y sus permisos."""
import secrets
import sqlite3
import uuid
from dataclasses import dataclass
from typing import List, Optional, Tuple

from acceso.db import now_ms, transaction
from acceso.store.errors import Conflict, Invalid, NotFound


@dataclass(frozen=True)
class HolderData:
    kind: str
    name: str
    department: str = ""
    address: str = ""
    notes: str = ""
    pin: Optional[str] = None
    keep_pin: bool = False  # PUT sin "pin": conservar el actual
    permission_ids: Tuple[int, ...] = ()


_SELECT = (
    "SELECT h.holder_id, h.kind, h.name, h.department, h.address, h.notes, h.pin, (h.pin IS NOT NULL) AS has_pin,"
    " (SELECT COUNT(*) FROM cards c WHERE c.holder_id = h.holder_id) AS card_count,"
    " (SELECT COUNT(*) FROM controls k WHERE k.holder_id = h.holder_id) AS control_count"
    " FROM holders h"
)


def _rows_to_dicts(conn: sqlite3.Connection, rows, with_pin: bool) -> List[dict]:
    perms = {}
    for r in conn.execute(
        "SELECT holder_id, permission_id FROM holder_permissions ORDER BY permission_id"
    ):
        perms.setdefault(r["holder_id"], []).append(r["permission_id"])
    result = []
    for r in rows:
        d = dict(r)
        d["permission_ids"] = perms.get(d["holder_id"], [])
        d["has_pin"] = bool(d["has_pin"])
        if not with_pin:
            del d["pin"]
        result.append(d)
    return result


def list_holders(conn: sqlite3.Connection, q: Optional[str] = None) -> List[dict]:
    sql, params = _SELECT, []
    if q and q.strip():
        like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sql += (
            " WHERE h.name LIKE ? ESCAPE '\\' OR h.department LIKE ? ESCAPE '\\'"
            " OR h.address LIKE ? ESCAPE '\\' OR h.notes LIKE ? ESCAPE '\\'"
        )
        params = [like] * 4
    sql += " ORDER BY LOWER(h.name), h.holder_id"
    return _rows_to_dicts(conn, conn.execute(sql, params).fetchall(), with_pin=False)


def get_holder(conn: sqlite3.Connection, holder_id: int) -> dict:
    rows = conn.execute(_SELECT + " WHERE h.holder_id = ?", (holder_id,)).fetchall()
    if not rows:
        raise NotFound("El titular %s no existe." % holder_id)
    return _rows_to_dicts(conn, rows, with_pin=True)[0]


def _check_permissions(conn: sqlite3.Connection, permission_ids) -> List[int]:
    unique = sorted(set(permission_ids))
    for pid in unique:
        if conn.execute("SELECT 1 FROM permissions WHERE permission_id = ?", (pid,)).fetchone() is None:
            raise Invalid("El permiso %s no existe." % pid)
    return unique


def _set_permissions(conn: sqlite3.Connection, holder_id: int, ids: List[int]) -> None:
    """Aplica solo la diferencia: las asignaciones que siguen conservan su uuid y no tocan la bandeja."""
    current = {r["permission_id"] for r in conn.execute(
        "SELECT permission_id FROM holder_permissions WHERE holder_id = ?", (holder_id,))}
    wanted = set(ids)
    conn.executemany(
        "DELETE FROM holder_permissions WHERE holder_id = ? AND permission_id = ?",
        [(holder_id, pid) for pid in sorted(current - wanted)],
    )
    stamp = now_ms()
    conn.executemany(
        "INSERT INTO holder_permissions(holder_id, permission_id, uuid, updated_at, origin)"
        " VALUES (?, ?, ?, ?, 'local')",
        [(holder_id, pid, str(uuid.uuid4()), stamp) for pid in sorted(wanted - current)],
    )


def _check_pin(conn: sqlite3.Connection, pin: Optional[str], holder_id: Optional[int]) -> None:
    if pin is None:
        return
    taken = conn.execute(
        "SELECT 1 FROM holders WHERE pin = ? AND holder_id IS NOT ?", (pin, holder_id)).fetchone()
    if taken is not None:
        raise Conflict("El PIN ya está asignado a otro titular.")


def generate_pin(conn: sqlite3.Connection) -> str:
    """6 dígitos aleatorios que ningún titular tiene; no lo guarda."""
    while True:
        pin = "%06d" % secrets.randbelow(10 ** 6)
        if conn.execute("SELECT 1 FROM holders WHERE pin = ?", (pin,)).fetchone() is None:
            return pin


def create_holder(conn: sqlite3.Connection, data: HolderData) -> int:
    with transaction(conn):
        ids = _check_permissions(conn, data.permission_ids)
        _check_pin(conn, data.pin, None)
        cur = conn.execute(
            "INSERT INTO holders(kind, name, department, address, notes, pin, uuid, updated_at,"
            " origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local')",
            (data.kind, data.name, data.department, data.address, data.notes, data.pin,
             str(uuid.uuid4()), now_ms()),
        )
        _set_permissions(conn, cur.lastrowid, ids)
        return cur.lastrowid


def update_holder(conn: sqlite3.Connection, holder_id: int, data: HolderData) -> None:
    with transaction(conn):
        if conn.execute("SELECT 1 FROM holders WHERE holder_id = ?", (holder_id,)).fetchone() is None:
            raise NotFound("El titular %s no existe." % holder_id)
        ids = _check_permissions(conn, data.permission_ids)
        pin = data.pin
        if data.keep_pin:
            pin = conn.execute("SELECT pin FROM holders WHERE holder_id = ?",
                               (holder_id,)).fetchone()["pin"]
        _check_pin(conn, pin, holder_id)
        conn.execute(
            "UPDATE holders SET kind=?, name=?, department=?, address=?, notes=?, pin=?,"
            " updated_at=?, origin='local' WHERE holder_id=?",
            (data.kind, data.name, data.department, data.address, data.notes, pin,
             now_ms(), holder_id),
        )
        _set_permissions(conn, holder_id, ids)


def delete_holder(conn: sqlite3.Connection, holder_id: int) -> None:
    with transaction(conn):
        cur = conn.execute("DELETE FROM holders WHERE holder_id = ?", (holder_id,))
        if cur.rowcount == 0:
            raise NotFound("El titular %s no existe." % holder_id)
