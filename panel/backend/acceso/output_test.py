"""Prueba de salidas: activa un relevador con su duración configurada y deja el log (origen 5)."""
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Union

from .constants import OUTPUT_COUNT, REASON_ALLOWED, REASON_UART_ERROR, SOURCE_TEST
from .db import connect
from .logs import append_log
from .protocol import build_relay_command

REQUESTED_BY_MAX = 120

INVALID_REQUEST = {"ok": False, "detail": "Petición inválida."}
BUSY = {"ok": False, "detail": "La salida ya se está probando"}
UART_FAILED = {"ok": False, "detail": "No se pudo enviar la orden al relevador."}


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


def _valid(request: Dict[str, Any]) -> bool:
    output = request.get("output")
    return (request.get("op") == "test_output"
            and isinstance(output, int) and not isinstance(output, bool)
            and 0 <= output < OUTPUT_COUNT
            and _valid_requested_by(request.get("requested_by")))


class OutputTester:
    """Atiende {"op": "test_output", "output": int, "requested_by": str}."""

    def __init__(self, db_path: Union[str, Path], relay: RelayLink, max_entries: int,
                 clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time) -> None:
        self._db_path = db_path
        self._relay = relay
        self._max_entries = max_entries
        self._clock = clock
        self._wall = wall
        self._lock = threading.Lock()
        self._busy_until = {}  # type: Dict[int, float]

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
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
            duration_ms = row["duration_ms"]
            with self._lock:
                if self._clock() < self._busy_until.get(output, float("-inf")):
                    return BUSY
                try:
                    self._relay.send(build_relay_command(output, duration_ms))
                    sent = True
                    self._busy_until[output] = self._clock() + duration_ms / 1000
                except OSError:
                    sent = False
            append_log(conn, timestamp=int(self._wall()), allowed=sent, source=SOURCE_TEST,
                       reason=REASON_ALLOWED if sent else REASON_UART_ERROR,
                       credential_label="Prueba — " + request["requested_by"],
                       output_id=output, max_entries=self._max_entries)
        finally:
            conn.close()
        return {"ok": True} if sent else UART_FAILED
