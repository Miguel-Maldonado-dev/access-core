"""Registro de eventos de acceso con recorte por cantidad."""
import sqlite3
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import List, Optional, Tuple

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


@dataclass(frozen=True)
class LogFilters:
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    holder_id: Optional[int] = None
    allowed: Optional[bool] = None
    source: Optional[int] = None


def _local_start(day: date) -> int:
    return int(datetime(day.year, day.month, day.day).timestamp())


def query_logs(
    conn: sqlite3.Connection, filters: LogFilters, page: int, page_size: int
) -> Tuple[List[dict], int]:
    """Devuelve (página de logs, total) del más nuevo al más antiguo.

    Las fechas son días en hora local del sistema: date_to incluye todo ese día
    (se compara contra la medianoche local del día siguiente).
    """
    where, params = [], []
    if filters.date_from is not None:
        where.append("timestamp >= ?")
        params.append(_local_start(filters.date_from))
    if filters.date_to is not None:
        where.append("timestamp < ?")
        params.append(_local_start(filters.date_to + timedelta(days=1)))
    if filters.holder_id is not None:
        where.append("holder_id = ?")
        params.append(filters.holder_id)
    if filters.allowed is not None:
        where.append("allowed = ?")
        params.append(1 if filters.allowed else 0)
    if filters.source is not None:
        where.append("source = ?")
        params.append(filters.source)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute("SELECT COUNT(*) FROM access_logs" + clause, params).fetchone()[0]
    rows = conn.execute(
        "SELECT log_id, timestamp, allowed, source, holder_id, holder_name, holder_kind,"
        " credential_label, control_id, code, device_id, output_id, reason"
        " FROM access_logs" + clause + " ORDER BY log_id DESC LIMIT ? OFFSET ?",
        params + [page_size, (page - 1) * page_size],
    ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["timestamp"] = datetime.fromtimestamp(item["timestamp"]).astimezone().isoformat()
        item["allowed"] = bool(item["allowed"])
        items.append(item)
    return items, total


def clear_logs(conn: sqlite3.Connection) -> None:
    with (nullcontext() if conn.in_transaction else transaction(conn)):
        conn.execute("DELETE FROM access_logs")
