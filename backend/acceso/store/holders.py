"""Titulares y sus permisos."""
import sqlite3
from dataclasses import dataclass
from typing import List, Optional, Tuple

from acceso.db import transaction
from acceso.store.errors import Invalid, NotFound


@dataclass(frozen=True)
class HolderData:
    kind: str
    name: str
    department: str = ""
    address: str = ""
    notes: str = ""
    permission_ids: Tuple[int, ...] = ()


_SELECT = (
    "SELECT h.holder_id, h.kind, h.name, h.department, h.address, h.notes,"
    " (SELECT COUNT(*) FROM cards c WHERE c.holder_id = h.holder_id) AS card_count,"
    " (SELECT COUNT(*) FROM controls k WHERE k.holder_id = h.holder_id) AS control_count"
    " FROM holders h"
)


def _rows_to_dicts(conn: sqlite3.Connection, rows) -> List[dict]:
    perms = {}
    for r in conn.execute(
        "SELECT holder_id, permission_id FROM holder_permissions ORDER BY permission_id"
    ):
        perms.setdefault(r["holder_id"], []).append(r["permission_id"])
    result = []
    for r in rows:
        d = dict(r)
        d["permission_ids"] = perms.get(d["holder_id"], [])
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
    return _rows_to_dicts(conn, conn.execute(sql, params).fetchall())


def get_holder(conn: sqlite3.Connection, holder_id: int) -> dict:
    rows = conn.execute(_SELECT + " WHERE h.holder_id = ?", (holder_id,)).fetchall()
    if not rows:
        raise NotFound("El titular %s no existe." % holder_id)
    return _rows_to_dicts(conn, rows)[0]


def _check_permissions(conn: sqlite3.Connection, permission_ids) -> List[int]:
    unique = sorted(set(permission_ids))
    for pid in unique:
        if conn.execute("SELECT 1 FROM permissions WHERE permission_id = ?", (pid,)).fetchone() is None:
            raise Invalid("El permiso %s no existe." % pid)
    return unique


def _set_permissions(conn: sqlite3.Connection, holder_id: int, ids: List[int]) -> None:
    conn.execute("DELETE FROM holder_permissions WHERE holder_id = ?", (holder_id,))
    conn.executemany(
        "INSERT INTO holder_permissions(holder_id, permission_id) VALUES (?, ?)",
        [(holder_id, pid) for pid in ids],
    )


def create_holder(conn: sqlite3.Connection, data: HolderData) -> int:
    with transaction(conn):
        ids = _check_permissions(conn, data.permission_ids)
        cur = conn.execute(
            "INSERT INTO holders(kind, name, department, address, notes) VALUES (?, ?, ?, ?, ?)",
            (data.kind, data.name, data.department, data.address, data.notes),
        )
        _set_permissions(conn, cur.lastrowid, ids)
        return cur.lastrowid


def update_holder(conn: sqlite3.Connection, holder_id: int, data: HolderData) -> None:
    with transaction(conn):
        if conn.execute("SELECT 1 FROM holders WHERE holder_id = ?", (holder_id,)).fetchone() is None:
            raise NotFound("El titular %s no existe." % holder_id)
        ids = _check_permissions(conn, data.permission_ids)
        conn.execute(
            "UPDATE holders SET kind=?, name=?, department=?, address=?, notes=? WHERE holder_id=?",
            (data.kind, data.name, data.department, data.address, data.notes, holder_id),
        )
        _set_permissions(conn, holder_id, ids)


def delete_holder(conn: sqlite3.Connection, holder_id: int) -> None:
    with transaction(conn):
        cur = conn.execute("DELETE FROM holders WHERE holder_id = ?", (holder_id,))
        if cur.rowcount == 0:
            raise NotFound("El titular %s no existe." % holder_id)
