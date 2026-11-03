"""Operaciones del socket del daemon sobre las salidas.

- test_output: prueba de salida con su duración configurada; deja el log con origen 5.
- remote_open: apertura remota a nombre de un titular, autorizada con allow_remote; origen 4.
"""
import re
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Union

from .access import METHOD_REMOTE, permission_allows
from .constants import (
    OUTPUT_COUNT, REASON_ALLOWED, REASON_NO_OUTPUT, REASON_NO_PERMISSION, REASON_UART_ERROR,
    REASON_UNKNOWN_HOLDER, SOURCE_REMOTE, SOURCE_TEST,
)
from .db import connect
from .logs import HolderRef, append_log
from .protocol import build_relay_command

REQUESTED_BY_MAX = 120

INVALID_REQUEST = {"ok": False, "detail": "Petición inválida."}
BUSY = {"ok": False, "detail": "La salida ya está en uso"}
UART_FAILED = {"ok": False, "detail": "No se pudo enviar la orden al relevador."}

# uuid canónico en minúsculas (como lo escribe la nube en holders.uuid).
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

REMOTE_DETAILS = {
    REASON_ALLOWED: "Salida abierta",
    REASON_UNKNOWN_HOLDER: "Titular desconocido",
    REASON_NO_OUTPUT: "La salida no existe o está deshabilitada",
    REASON_NO_PERMISSION: "Sin permiso de apertura remota",
    REASON_UART_ERROR: "No se pudo enviar la orden al relevador.",
}  # type: Dict[int, str]
REMOTE_BUSY = {"ok": False, "reason": REASON_ALLOWED, "detail": "La salida ya está en uso"}


class RelayLink:
    """El `send` del puerto abierto, compartido por el daemon y la prueba bajo un mismo candado."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._send = None  # type: Optional[Callable[[bytes], None]]

    def set(self, send: Optional[Callable[[bytes], None]]) -> None:
        with self._lock:
            self._send = send

    def send(self, frame: bytes) -> None:
        with self._lock:
            if self._send is None:
                raise OSError("Puerto serie no disponible")
            self._send(frame)


def _valid_requested_by(value: Any) -> bool:
    return (isinstance(value, str) and 1 <= len(value) <= REQUESTED_BY_MAX
            and not any(unicodedata.category(ch) == "Cc" for ch in value))


def _valid_output(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < OUTPUT_COUNT


def _valid(request: Dict[str, Any]) -> bool:
    return (request.get("op") == "test_output"
            and _valid_output(request.get("output"))
            and _valid_requested_by(request.get("requested_by")))


def _valid_remote(request: Dict[str, Any]) -> bool:
    holder_uuid = request.get("holder_uuid")
    return (request.get("op") == "remote_open"
            and _valid_output(request.get("output"))
            and isinstance(holder_uuid, str) and _UUID_RE.fullmatch(holder_uuid) is not None
            and _valid_requested_by(request.get("requested_by")))


def _remote_reply(reason: int) -> Dict[str, Any]:
    return {"ok": reason == REASON_ALLOWED, "reason": reason, "detail": REMOTE_DETAILS[reason]}


class OutputTester:
    """Atiende las operaciones del socket del daemon sobre las salidas:

    {"op": "test_output", "output": int, "requested_by": str} y
    {"op": "remote_open", "output": int, "holder_uuid": str, "requested_by": str}.
    """

    def __init__(self, db_path: Union[str, Path], relay: RelayLink, max_entries: int,
                 clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time,
                 now: Callable[[], datetime] = datetime.now) -> None:
        self._db_path = db_path
        self._relay = relay
        self._max_entries = max_entries
        self._clock = clock
        self._wall = wall
        self._now = now  # hora local para el horario de los permisos (como en access.py)
        self._lock = threading.Lock()
        self._busy_until = {}  # type: Dict[int, float]

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        if request.get("op") == "remote_open":
            return self._remote_open(request)
        return self._test_output(request)

    def _send_if_free(self, output: int, duration_ms: int) -> Optional[bool]:
        """Envía la orden si la salida no está ocupada: None si ocupada; True/False si se envió."""
        with self._lock:
            if self._clock() < self._busy_until.get(output, float("-inf")):
                return None
            try:
                self._relay.send(build_relay_command(output, duration_ms))
            except OSError:
                return False
            self._busy_until[output] = self._clock() + duration_ms / 1000
            return True

    def _remote_open(self, request: Dict[str, Any]) -> Dict[str, Any]:
        if not _valid_remote(request):
            return INVALID_REQUEST
        output = request["output"]  # type: int
        requested_by = request["requested_by"]  # type: str
        conn = connect(self._db_path)
        try:
            holder = None  # type: Optional[HolderRef]
            row = conn.execute("SELECT holder_id, name, kind FROM holders WHERE uuid = ?",
                               (request["holder_uuid"],)).fetchone()
            if row is None:
                reason = REASON_UNKNOWN_HOLDER
            else:
                holder = HolderRef(row["holder_id"], row["name"], row["kind"])
                out = conn.execute(
                    "SELECT duration_ms FROM outputs WHERE output_id = ? AND enabled = 1",
                    (output,)).fetchone()
                if out is None:
                    reason = REASON_NO_OUTPUT
                elif not permission_allows(conn, holder.holder_id, output, METHOD_REMOTE, None,
                                           self._now()):
                    reason = REASON_NO_PERMISSION
                else:
                    sent = self._send_if_free(output, out["duration_ms"])
                    if sent is None:
                        return REMOTE_BUSY
                    reason = REASON_ALLOWED if sent else REASON_UART_ERROR
            append_log(conn, timestamp=int(self._wall()), allowed=reason == REASON_ALLOWED,
                       source=SOURCE_REMOTE, reason=reason, holder=holder,
                       credential_label=requested_by, output_id=output,
                       max_entries=self._max_entries)
        finally:
            conn.close()
        return _remote_reply(reason)

    def _test_output(self, request: Dict[str, Any]) -> Dict[str, Any]:
        if not _valid(request):
            return INVALID_REQUEST
        output = request["output"]  # type: int
        conn = connect(self._db_path)
        try:
            # Sin filtrar por `enabled`: una salida deshabilitada también se prueba.
            row = conn.execute("SELECT duration_ms FROM outputs WHERE output_id = ?",
                               (output,)).fetchone()
            if row is None:
                return {"ok": False, "detail": "La salida %d no existe." % (output + 1)}
            sent = self._send_if_free(output, row["duration_ms"])
            if sent is None:
                return BUSY
            append_log(conn, timestamp=int(self._wall()), allowed=sent, source=SOURCE_TEST,
                       reason=REASON_ALLOWED if sent else REASON_UART_ERROR,
                       credential_label="Prueba — " + request["requested_by"],
                       output_id=output, max_entries=self._max_entries)
        finally:
            conn.close()
        return {"ok": True} if sent else UART_FAILED
