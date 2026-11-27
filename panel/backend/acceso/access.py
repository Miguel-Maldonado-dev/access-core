"""Autorización de tarjetas, controles RF y botones de salida."""
import logging
import sqlite3
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Dict, List, Optional, Tuple

from .constants import (
    EXIT_BUTTON_OUTPUTS, PIN_FAILURE_WINDOW_S, PIN_LOCKOUT_S, PIN_MAX_FAILURES, QR_DEBOUNCE_S, REASON_ALLOWED,
    REASON_BUTTON_NO_OUTPUT, REASON_EXIT_BUTTON, REASON_METHOD_NOT_ALLOWED,
    REASON_NO_OUTPUT, REASON_NO_PERMISSION, REASON_PIN_LOCKED, REASON_PIN_NOT_ALLOWED, REASON_QR_EXPIRED,
    REASON_QR_UNKNOWN, REASON_QR_USED, REASON_UART_ERROR,
    REASON_UNKNOWN_CARD, REASON_UNKNOWN_CONTROL, REASON_UNKNOWN_PIN, SOURCE_CARD,
    SOURCE_EXIT_BUTTON, SOURCE_PIN, SOURCE_QR, SOURCE_RF,
)
from .logs import HolderRef, append_log
from .qr import get_qr_settings, looks_like_qr
from .protocol import CardRead, Event, ExitButton, PinRead, RfRead, build_relay_command
from .rf_listen import RfListener

log = logging.getLogger("acceso.access")


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
    qr_id: Optional[int] = None

    @property
    def allowed(self) -> bool:
        return self.reason in (REASON_ALLOWED, REASON_EXIT_BUTTON)


@dataclass(frozen=True)
class AccessOutcome:
    allowed: bool
    reason: int
    command: Optional[bytes]
    log_id: Optional[int]


METHOD_CARD, METHOD_PIN, METHOD_RF = "card", "pin", "rf"
METHOD_REMOTE = "remote"
METHOD_CALL = "call"
METHOD_QR = "qr"


class QrDebounce:
    """Rebote en memoria: un lector de QR repite la lectura mientras el código sigue a la vista."""

    def __init__(self) -> None:
        self._seen: Dict[Tuple[int, int], float] = {}

    def seen(self, code: int, reader: int, now: float) -> bool:
        """Verdadero si hubo otra lectura aceptada del mismo código y lector hace < QR_DEBOUNCE_S.

        Una lectura rebotada no renueva la ventana: la cuenta parte de la primera.
        """
        for key in [k for k, t in self._seen.items() if now - t >= QR_DEBOUNCE_S or t > now]:
            del self._seen[key]
        key = (code, reader)
        if key in self._seen:
            return True
        self._seen[key] = now
        return False


def _method_ok(p: sqlite3.Row, method: str, reader: Optional[int]) -> bool:
    if method == METHOD_RF:
        return p["allow_rf"] == 1
    if method == METHOD_REMOTE:
        return p["allow_remote"] == 1
    if method == METHOD_CALL:
        return p["allow_call"] == 1
    if reader is None:
        return False
    if method == METHOD_PIN:
        return bool(p["pin_reader_mask"] & (1 << reader))
    if method == METHOD_CARD:
        return bool(p["card_reader_mask"] & (1 << reader))
    if method == METHOD_QR:
        return bool(p["qr_reader_mask"] & (1 << reader))
    return False


def _permission_rows(conn: sqlite3.Connection, holder_id: int) -> List[sqlite3.Row]:
    return conn.execute(
        "SELECT p.output_mask, p.card_reader_mask, p.pin_reader_mask, p.qr_reader_mask, p.allow_rf,"
        " p.allow_remote, p.allow_call, p.weekday_mask, p.start_minute, p.end_minute"
        " FROM permissions p JOIN holder_permissions hp ON hp.permission_id = p.permission_id"
        " WHERE hp.holder_id = ?",
        (holder_id,),
    ).fetchall()


def method_enabled(conn: sqlite3.Connection, holder_id: int, method: str,
                   reader: Optional[int]) -> bool:
    """Algún permiso del titular habilita el método (y el lector), sin mirar salida ni horario."""
    return any(_method_ok(p, method, reader) for p in _permission_rows(conn, holder_id))


def permission_check(conn: sqlite3.Connection, holder_id: int, output_id: int,
                     method: str, reader: Optional[int], now: datetime) -> int:
    """REASON_ALLOWED si algún permiso cubre método, salida, día y horario.

    Si ningún permiso habilita el método en ese lector devuelve REASON_METHOD_NOT_ALLOWED (17);
    si lo habilita pero no cubre salida, día u horario, REASON_NO_PERMISSION (3).
    card/pin/qr: el bit del lector debe estar en su máscara; rf: allow_rf=1; remote: allow_remote=1;
    call: allow_call=1 (rf, remote y call no usan lector: reader=None).
    """
    minute = now.hour * 60 + now.minute
    day = 1 << now.weekday()
    enabled = False
    for p in _permission_rows(conn, holder_id):
        if not _method_ok(p, method, reader):
            continue
        enabled = True
        start, end = p["start_minute"], p["end_minute"]
        if start == end:
            time_ok = True
        elif start < end:
            time_ok = start <= minute < end
        else:
            time_ok = minute >= start or minute < end
        if p["output_mask"] & (1 << output_id) and p["weekday_mask"] & day and time_ok:
            return REASON_ALLOWED
    return REASON_NO_PERMISSION if enabled else REASON_METHOD_NOT_ALLOWED


def permission_allows(conn: sqlite3.Connection, holder_id: int, output_id: int,
                      method: str, reader: Optional[int], now: datetime) -> bool:
    return permission_check(conn, holder_id, output_id, method, reader, now) == REASON_ALLOWED


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
    reason = permission_check(conn, holder.holder_id, output.output_id, METHOD_CARD, reader, now)
    return Decision(reason, holder, output, credential_label=label)


LOW24_MASK = 0xFFFFFF


def _registered_card_code(conn: sqlite3.Connection, code: int) -> Optional[int]:
    """Código de la tarjeta registrada que corresponde a una lectura, o None.

    Primero el código completo; si no existe y la lectura pasa de 24 bits (lector de 34 bits,
    el firmware manda los 32 bits), los 24 bits bajos: las tarjetas se dan de alta con su
    número impreso."""
    candidates = [code]
    if code > LOW24_MASK:
        candidates.append(code & LOW24_MASK)
    for candidate in candidates:
        if conn.execute("SELECT 1 FROM cards WHERE card_code = ?", (candidate,)).fetchone():
            return candidate
    return None


def authorize_qr(conn: sqlite3.Connection, qr: sqlite3.Row, reader: int, now: datetime) -> Decision:
    """Decide un QR registrado. Orden: método no habilitado (17), vigencia (15), usos agotados en
    el lector (16), sin salida (2), día/horario/salida (3); si no, abre."""
    holder = _holder(conn, qr["holder_id"])
    label = qr["label"] or None
    common = dict(holder=holder, credential_label=label, qr_id=qr["qr_id"])
    if not method_enabled(conn, holder.holder_id, METHOD_QR, reader):
        return Decision(REASON_METHOD_NOT_ALLOWED, **common)
    ts = int(now.timestamp())
    if not qr["valid_from"] <= ts < qr["valid_until"]:
        return Decision(REASON_QR_EXPIRED, **common)
    used = conn.execute("SELECT count FROM qr_uses WHERE qr_id = ? AND reader = ?",
                        (qr["qr_id"], reader)).fetchone()
    if used is not None and used["count"] >= qr["max_uses"]:
        return Decision(REASON_QR_USED, **common)
    out = conn.execute(
        "SELECT output_id, duration_ms FROM outputs WHERE enabled = 1"
        " AND (reader_mask & ?) != 0 ORDER BY output_id LIMIT 1",
        (1 << reader,),
    ).fetchone()
    if out is None:
        return Decision(REASON_NO_OUTPUT, **common)
    output = OutputRef(out["output_id"], out["duration_ms"])
    reason = permission_check(conn, holder.holder_id, output.output_id, METHOD_QR, reader, now)
    return Decision(reason, output=output, **common)


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
                 pin_lockout: Optional[PinLockout] = None,
                 rf_listener: Optional[RfListener] = None,
                 qr_debounce: Optional[QrDebounce] = None,
                 clock: Callable[[], float] = time.monotonic) -> AccessOutcome:
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
        qr = conn.execute("SELECT * FROM qr_codes WHERE code = ?", (event.code,)).fetchone()
        code = event.code
        card_code = None if qr is not None else _registered_card_code(conn, event.code)
        if qr is not None:
            if qr_debounce is not None and qr_debounce.seen(event.code, event.reader, clock()):
                return AccessOutcome(False, REASON_QR_USED, None, None)
            decision = authorize_qr(conn, qr, event.reader, now)
            source = SOURCE_QR
        elif card_code is not None:
            # Puede ser los 24 bits bajos: el log lleva el código registrado.
            decision = authorize_card(conn, card_code, event.reader, now)
            source, code = SOURCE_CARD, card_code
        elif looks_like_qr(event.code, get_qr_settings(conn).digit):
            decision = Decision(REASON_QR_UNKNOWN)
            source = SOURCE_QR
        else:
            decision = authorize_card(conn, event.code, event.reader, now)
            source = SOURCE_CARD
        device_id = event.reader
    elif isinstance(event, PinRead):
        if pin_lockout is not None and pin_lockout.is_blocked(event.reader, now):
            decision = Decision(REASON_PIN_LOCKED, credential_label=PIN_LABEL)
        else:
            decision = authorize_pin(conn, event.pin, event.reader, now)
            if pin_lockout is not None:
                pin_lockout.record(event.reader, decision.reason, now)
        source, device_id = SOURCE_PIN, event.reader
    else:
        if rf_listener is not None:
            try:
                rf_listener.offer(event.code)  # la escucha de "Escuchar" ve todo código RF
            except Exception:
                log.exception("No se pudo entregar el código RF a la escucha")
        decision = authorize_rf(conn, event.code, now)
        if decision.reason == REASON_UNKNOWN_CONTROL:
            # Un RF desconocido (vecino, ruido) no se registra: llenaría el log.
            return AccessOutcome(False, REASON_UNKNOWN_CONTROL, None, None)
        source, device_id, code = SOURCE_RF, decision.button, event.code

    reason, command = decision.reason, None
    if decision.allowed:
        try:
            command = build_relay_command(decision.output.output_id, decision.output.duration_ms)
            send(command)
        except OSError:
            reason, command = REASON_UART_ERROR, None
    qr_use = ((decision.qr_id, event.reader)
              if reason == REASON_ALLOWED and decision.qr_id is not None else None)
    log_id = append_log(
        conn, timestamp=timestamp, allowed=reason == REASON_ALLOWED, source=source,
        reason=reason, holder=decision.holder, credential_label=decision.credential_label,
        control_id=decision.control_id, code=code, device_id=device_id,
        output_id=decision.output.output_id if decision.output else None,
        max_entries=max_entries, qr_use=qr_use)
    return AccessOutcome(reason == REASON_ALLOWED, reason, command, log_id)
