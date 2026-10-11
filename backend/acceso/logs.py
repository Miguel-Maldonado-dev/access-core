"""Registro de eventos de acceso con recorte por cantidad."""
import sqlite3
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Optional

from .db import transaction


@dataclass(frozen=True)
class HolderRef:
    holder_id: int
    name: str
    kind: str


def append_log(
    conn: sqlite3.Connection,
    *,
    timestamp: int,
    allowed: bool,
    source: int,
    reason: int,
    holder: Optional[HolderRef] = None,
    credential_label: Optional[str] = None,
    control_id: Optional[int] = None,
    code: Optional[int] = None,
    device_id: Optional[int] = None,
    output_id: Optional[int] = None,
    max_entries: int,
) -> int:
    """Inserta el log (con copia del titular) y borra los más antiguos que excedan max_entries."""
    with (nullcontext() if conn.in_transaction else transaction(conn)):
        cur = conn.execute(
            "INSERT INTO access_logs(timestamp, allowed, source, holder_id, holder_name,"
            " holder_kind, credential_label, control_id, code, device_id, output_id, reason)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                timestamp, 1 if allowed else 0, source,
                holder.holder_id if holder else None,
                holder.name if holder else None,
                holder.kind if holder else None,
                credential_label, control_id, code, device_id, output_id, reason,
            ),
        )
        conn.execute(
            "DELETE FROM access_logs WHERE log_id < (SELECT log_id FROM access_logs"
            " ORDER BY log_id DESC LIMIT 1 OFFSET :max_entries - 1)",
            {"max_entries": max_entries},
        )
        return cur.lastrowid
