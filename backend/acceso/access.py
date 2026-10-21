"""Autorización de tarjetas, controles RF y botones de salida."""
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Dict, List, Optional

from .constants import (
    EXIT_BUTTON_OUTPUTS, PIN_FAILURE_WINDOW_S, PIN_LOCKOUT_S, PIN_MAX_FAILURES, REASON_ALLOWED, REASON_BUTTON_NO_OUTPUT, REASON_EXIT_BUTTON,
    REASON_NO_OUTPUT, REASON_NO_PERMISSION, REASON_PIN_LOCKED, REASON_PIN_NOT_ALLOWED, REASON_UART_ERROR,
    REASON_UNKNOWN_CARD, REASON_UNKNOWN_CONTROL, REASON_UNKNOWN_PIN, SOURCE_CARD,
    SOURCE_EXIT_BUTTON, SOURCE_PIN, SOURCE_RF,
)
from .logs import HolderRef, append_log
from .protocol import CardRead, Event, ExitButton, PinRead, RfRead, build_relay_command


# Etiqueta fija del log: los dígitos del PIN nunca se guardan.
PIN_LABEL = "PIN"


class PinLockout:
    """Bloqueo en memoria por lector tras demasiados PIN fallidos (motivos 8 y 9)."""

    def __init__(self) -> None:
        self._failures: Dict[int, List[float]] = defaultdict(list)
        self._blocked_until: Dict[int, float] = {}

    def is_blocked(self, reader: int, now: datetime) -> bool:
        return self._blocked_until.get(reader, 0.0) > now.timestamp()

    def record(self, reader: int, reason: int, now: datetime) -> None:
        ts = now.timestamp()
        if reason == REASON_ALLOWED:
            self._failures.pop(reader, None)
        elif reason in (REASON_UNKNOWN_PIN, REASON_PIN_NOT_ALLOWED):
            recent = [t for t in self._failures[reader] if ts - t < PIN_FAILURE_WINDOW_S]
            recent.append(ts)
            if len(recent) >= PIN_MAX_FAILURES:
                self._blocked_until[reader] = ts + PIN_LOCKOUT_S
                recent = []
            self._failures[reader] = recent


@dataclass(frozen=True)
class OutputRef:
    output_id: int
    duration_ms: int


@dataclass(frozen=True)
class Decision:
    reason: int
    holder: Optional[HolderRef] = None
    output: Optional[OutputRef] = None
    control_id: Optional[int] = None
    button: Optional[int] = None
    credential_label: Optional[str] = None

    @property
    def allowed(self) -> bool:
        return self.reason in (REASON_ALLOWED, REASON_EXIT_BUTTON)


@dataclass(frozen=True)
class AccessOutcome:
    allowed: bool
    reason: int
    command: Optional[bytes]
    log_id: int


METHOD_CARD, METHOD_PIN, METHOD_RF = "card", "pin", "rf"


def permission_allows(conn: sqlite3.Connection, holder_id: int, output_id: int,
                      method: str, reader: Optional[int], now: datetime) -> bool:
    """Algún permiso del titular cubre método, salida, día y horario.

    card: el bit del lector debe estar en card_reader_mask; pin: en pin_reader_mask;
    rf: el permiso debe tener allow_rf=1 y el lector no aplica (reader=None).
    """
    minute = now.hour * 60 + now.minute
    day = 1 << now.weekday()
    rows = conn.execute(
        "SELECT p.output_mask, p.card_reader_mask, p.pin_reader_mask, p.allow_rf, p.weekday_mask,"
        " p.start_minute, p.end_minute"
        " FROM permissions p JOIN holder_permissions hp ON hp.permission_id = p.permission_id"
        " WHERE hp.holder_id = ?",
        (holder_id,),
    )
    for p in rows:
        start, end = p["start_minute"], p["end_minute"]
        if start == end:
            time_ok = True
        elif start < end:
            time_ok = start <= minute < end
        else:
            time_ok = minute >= start or minute < end
        if method == METHOD_RF:
            method_ok = p["allow_rf"] == 1
        elif method == METHOD_PIN:
            method_ok = reader is not None and bool(p["pin_reader_mask"] & (1 << reader))
        elif method == METHOD_CARD:
            method_ok = reader is not None and bool(p["card_reader_mask"] & (1 << reader))
        else:
            method_ok = False
        if (method_ok and p["output_mask"] & (1 << output_id)
                and p["weekday_mask"] & day and time_ok):
            return True
    return False


def _holder(conn: sqlite3.Connection, holder_id: int) -> HolderRef:
    row = conn.execute("SELECT holder_id, name, kind FROM holders WHERE holder_id = ?",
                       (holder_id,)).fetchone()
    return HolderRef(row["holder_id"], row["name"], row["kind"])


def authorize_card(conn: sqlite3.Connection, code: int, reader: int, now: datetime) -> Decision:
    card = conn.execute(
        "SELECT holder_id, NULLIF(description, '') AS label FROM cards WHERE card_code = ?",
        (code,),
    ).fetchone()
    if card is None:
        return Decision(REASON_UNKNOWN_CARD)
    holder = _holder(conn, card["holder_id"])
    label = card["label"]
    out = conn.execute(
        "SELECT output_id, duration_ms FROM outputs WHERE enabled = 1"
        " AND (reader_mask & ?) != 0 ORDER BY output_id LIMIT 1",
        (1 << reader,),
    ).fetchone()
    if out is None:
        return Decision(REASON_NO_OUTPUT, holder, credential_label=label)
    output = OutputRef(out["output_id"], out["duration_ms"])
    reason = (REASON_ALLOWED
              if permission_allows(conn, holder.holder_id, output.output_id, METHOD_CARD,
                                   reader, now)
              else REASON_NO_PERMISSION)
    return Decision(reason, holder, output, credential_label=label)


def authorize_pin(conn: sqlite3.Connection, pin: str, reader: int, now: datetime) -> Decision:
    row = conn.execute("SELECT holder_id FROM holders WHERE pin = ?", (pin,)).fetchone()
    if row is None:
        return Decision(REASON_UNKNOWN_PIN, credential_label=PIN_LABEL)
    holder = _holder(conn, row["holder_id"])
    out = conn.execute(
        "SELECT output_id, duration_ms FROM outputs WHERE enabled = 1"
        " AND (reader_mask & ?) != 0 ORDER BY output_id LIMIT 1",
        (1 << reader,),
    ).fetchone()
    if out is None:
        return Decision(REASON_NO_OUTPUT, holder, credential_label=PIN_LABEL)
    output = OutputRef(out["output_id"], out["duration_ms"])
    reason = (REASON_ALLOWED
              if permission_allows(conn, holder.holder_id, output.output_id, METHOD_PIN,
                                   reader, now)
              else REASON_PIN_NOT_ALLOWED)
    return Decision(reason, holder, output, credential_label=PIN_LABEL)


def authorize_rf(conn: sqlite3.Connection, code: int, now: datetime) -> Decision:
    row = conn.execute(
        "SELECT b.control_id, b.button, b.output_id, c.holder_id,"
        " NULLIF(c.description, '') AS label"
        " FROM control_buttons b JOIN controls c ON c.control_id = b.control_id"
        " WHERE b.rf_code = ?",
        (code,),
    ).fetchone()
    if row is None:
        return Decision(REASON_UNKNOWN_CONTROL)
    holder = _holder(conn, row["holder_id"])
    common = dict(holder=holder, control_id=row["control_id"], button=row["button"],
                  credential_label=row["label"])
    if row["output_id"] is None:
        return Decision(REASON_BUTTON_NO_OUTPUT, **common)
    out = conn.execute(
        "SELECT output_id, duration_ms FROM outputs WHERE output_id = ? AND enabled = 1",
        (row["output_id"],),
    ).fetchone()
    if out is None:
        return Decision(REASON_NO_OUTPUT, **common)
    output = OutputRef(out["output_id"], out["duration_ms"])
    if not permission_allows(conn, holder.holder_id, output.output_id, METHOD_RF, None, now):
        return Decision(REASON_NO_PERMISSION, output=output, **common)
    return Decision(REASON_ALLOWED, output=output, **common)


def handle_event(conn: sqlite3.Connection, event: Event, send: Callable[[bytes], None], *,
                 now: Optional[datetime] = None, max_entries: int,
                 pin_lockout: Optional[PinLockout] = None) -> AccessOutcome:
    now = now or datetime.now()
    timestamp = int(now.timestamp())
    if isinstance(event, ExitButton):
        output_id = EXIT_BUTTON_OUTPUTS[event.button]
        log_id = append_log(conn, timestamp=timestamp, allowed=True, source=SOURCE_EXIT_BUTTON,
                            reason=REASON_EXIT_BUTTON, device_id=event.button,
                            output_id=output_id, max_entries=max_entries)
        return AccessOutcome(True, REASON_EXIT_BUTTON, None, log_id)

    code: Optional[int] = None
    if isinstance(event, CardRead):
        decision = authorize_card(conn, event.code, event.reader, now)
        source, device_id, code = SOURCE_CARD, event.reader, event.code
    elif isinstance(event, PinRead):
        if pin_lockout is not None and pin_lockout.is_blocked(event.reader, now):
            decision = Decision(REASON_PIN_LOCKED, credential_label=PIN_LABEL)
        else:
            decision = authorize_pin(conn, event.pin, event.reader, now)
            if pin_lockout is not None:
                pin_lockout.record(event.reader, decision.reason, now)
        source, device_id = SOURCE_PIN, event.reader
    else:
        decision = authorize_rf(conn, event.code, now)
        source, device_id, code = SOURCE_RF, decision.button, event.code

    reason, command = decision.reason, None
    if decision.allowed:
        try:
            command = build_relay_command(decision.output.output_id, decision.output.duration_ms)
            send(command)
        except OSError:
            reason, command = REASON_UART_ERROR, None
    log_id = append_log(
        conn, timestamp=timestamp, allowed=reason == REASON_ALLOWED, source=source,
        reason=reason, holder=decision.holder, credential_label=decision.credential_label,
        control_id=decision.control_id, code=code, device_id=device_id,
        output_id=decision.output.output_id if decision.output else None,
        max_entries=max_entries)
    return AccessOutcome(reason == REASON_ALLOWED, reason, command, log_id)
