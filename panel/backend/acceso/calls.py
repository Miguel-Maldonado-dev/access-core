"""Autorización de aperturas por llamada telefónica (SIM808): identificación, límite y logs."""
import re
import sqlite3
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, FrozenSet, List, Optional, Union

from .access import METHOD_CALL, permission_allows
from .constants import (
    CALL_LIMIT_PER_MINUTE, OUTPUT_COUNT, REASON_ALLOWED, REASON_CALL_LIMIT, REASON_NO_OUTPUT,
    REASON_NO_PERMISSION, REASON_UART_ERROR, REASON_UNKNOWN_PHONE, SOURCE_CALL,
)
from .db import connect
from .logs import HolderRef, append_log
from .phones import normalize_phone

HIDDEN_LABEL = "Oculto"
LABEL_MAX = 20
LIMIT_WINDOW_S = 60.0

_QUOTED = re.compile(r'"([^"]*)"')


@dataclass(frozen=True)
class CallSettings:
    enabled: bool
    mode: str
    output_id: int
    menu_mask: int
    default_output: Optional[int]
    call_limit_per_minute: int = CALL_LIMIT_PER_MINUTE


def load_call_settings(conn: sqlite3.Connection) -> CallSettings:
    row = conn.execute("SELECT enabled, mode, output_id, menu_mask, default_output,"
                       " call_limit_per_minute"
                       " FROM call_settings WHERE id = 1").fetchone()
    if row is None:
        return CallSettings(False, "single", 0, 0, None)
    return CallSettings(bool(row["enabled"]), row["mode"], row["output_id"], row["menu_mask"],
                        row["default_output"], row["call_limit_per_minute"])


class CallRateLimiter:
    """Aperturas por número en una ventana de 60 s, en memoria."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._openings = defaultdict(list)  # type: Dict[str, List[float]]

    def _recent(self, number: str, now: float) -> List[float]:
        recent = [t for t in self._openings.get(number, []) if now - t < LIMIT_WINDOW_S]
        if recent:
            self._openings[number] = recent
        else:
            self._openings.pop(number, None)
        return recent

    def allowed(self, number: str, now: float, limit: int = CALL_LIMIT_PER_MINUTE) -> bool:
        with self._lock:
            return len(self._recent(number, now)) < limit

    def record(self, number: str, now: float) -> None:
        with self._lock:
            recent = self._recent(number, now)
            recent.append(now)
            self._openings[number] = recent


@dataclass(frozen=True)
class CallLookup:
    number: Optional[str]
    label: str
    holder: Optional[HolderRef]


def _clip_field(raw_clip: str) -> str:
    """Número crudo de una línea +CLIP (o del argumento ya recortado)."""
    raw = raw_clip or ""
    match = _QUOTED.search(raw)
    if match:
        return match.group(1).strip()
    return raw.split(",")[0].strip()


class CallAuthorizer:
    def __init__(self, db_path: Union[str, Path], opener: Callable[[int, int], Optional[bool]],
                 max_entries: int, wall: Callable[[], float] = time.time,
                 now: Callable[[], datetime] = datetime.now,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._db_path = db_path
        self._opener = opener
        self._max_entries = max_entries
        self._wall = wall
        self._now = now
        self._clock = clock
        self._limiter = CallRateLimiter()

    def identify(self, raw_clip: str) -> CallLookup:
        field = _clip_field(raw_clip)
        if not field:
            return CallLookup(None, HIDDEN_LABEL, None)
        number = normalize_phone(field)
        if number is None:
            return CallLookup(None, field[:LABEL_MAX], None)
        conn = connect(self._db_path)
        try:
            row = conn.execute(
                "SELECT h.holder_id, h.name, h.kind FROM phones p"
                " JOIN holders h ON h.holder_id = p.holder_id WHERE p.number = ?",
                (number,)).fetchone()
        finally:
            conn.close()
        holder = HolderRef(row["holder_id"], row["name"], row["kind"]) if row else None
        return CallLookup(number, number, holder)

    @staticmethod
    def _eligible(settings: CallSettings) -> List[int]:
        if settings.mode == "menu":
            return [o for o in range(OUTPUT_COUNT) if settings.menu_mask & (1 << o)]
        return [settings.output_id]

    def _permitted(self, conn: sqlite3.Connection, lookup: CallLookup,
                   outputs: List[int]) -> FrozenSet[int]:
        if lookup.holder is None:
            return frozenset()
        now = self._now()
        return frozenset(o for o in outputs
                         if permission_allows(conn, lookup.holder.holder_id, o, METHOD_CALL,
                                              None, now))

    def pre_check(self, lookup: CallLookup, settings: CallSettings) -> Optional[int]:
        if lookup.holder is None or lookup.number is None:
            return REASON_UNKNOWN_PHONE
        if not self._limiter.allowed(lookup.number, self._clock(), settings.call_limit_per_minute):
            return REASON_CALL_LIMIT
        if not self.menu_outputs(lookup, settings):
            return REASON_NO_PERMISSION
        return None

    def menu_outputs(self, lookup: CallLookup, settings: CallSettings) -> FrozenSet[int]:
        if lookup.holder is None:
            return frozenset()
        conn = connect(self._db_path)
        try:
            return self._permitted(conn, lookup, self._eligible(settings))
        finally:
            conn.close()

    def _log(self, conn: sqlite3.Connection, lookup: CallLookup, reason: int, allowed: bool,
             key: Optional[int], output: Optional[int]) -> None:
        append_log(conn, timestamp=int(self._wall()), allowed=allowed, source=SOURCE_CALL,
                   reason=reason, holder=lookup.holder, credential_label=lookup.label,
                   code=None, device_id=key, output_id=output, max_entries=self._max_entries)

    def reject(self, lookup: CallLookup, reason: int, key: Optional[int] = None) -> None:
        conn = connect(self._db_path)
        try:
            self._log(conn, lookup, reason, False, key, None)
        finally:
            conn.close()

    def open(self, lookup: CallLookup, output: int, key: Optional[int]) -> int:
        conn = connect(self._db_path)
        try:
            allowed = False
            row = conn.execute("SELECT duration_ms FROM outputs WHERE output_id = ? AND enabled = 1",
                               (output,)).fetchone()
            if row is None:
                reason = REASON_NO_OUTPUT
            elif lookup.holder is None or not permission_allows(
                    conn, lookup.holder.holder_id, output, METHOD_CALL, None, self._now()):
                reason = REASON_NO_PERMISSION
            else:
                sent = self._opener(output, row["duration_ms"])
                if sent is None:
                    reason = REASON_ALLOWED  # ocupada: se registra el intento sin apertura
                elif sent:
                    reason, allowed = REASON_ALLOWED, True
                    if lookup.number is not None:
                        self._limiter.record(lookup.number, self._clock())
                else:
                    reason = REASON_UART_ERROR
            self._log(conn, lookup, reason, allowed, key, output)
            return reason
        finally:
            conn.close()
