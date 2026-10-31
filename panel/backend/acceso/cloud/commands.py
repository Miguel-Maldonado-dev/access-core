"""Órdenes de la nube que el agente ejecuta en su propio hilo: hoy solo `test_output`.

La orden llega por MQTT (`acc/<panel_code>/cmd`), se valida, se descarta si ya caducó o si su
`command_id` ya se vio, y se pasa al daemon por su socket local. El resultado se informa a la nube
con `POST /api/device/v1/command-result`. Una orden inválida, caducada o repetida se descarta sin
informar: la nube la deja vencer. De una excepción inesperada solo se registra el tipo.
"""
import logging
import queue
import re
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from typing import Any, Callable, Dict, Mapping, Optional

from acceso.daemon_socket import DaemonUnavailable

log = logging.getLogger("acceso.cloud")

OUTPUT_MAX = 3
REQUESTED_BY_MAX = 120
# Las órdenes viven 10 s en la nube: 256 identificadores cubren de sobra esa vigencia.
SEEN_MAX = 256
QUEUE_MAX = 64
# stop() no espera a una orden en curso (hasta 7 s del daemon más la llamada a la nube).
STOP_WAIT_S = 0.2
DAEMON_DOWN = "El daemon no responde"
# La nube rechaza un `detail` de más de 200 caracteres.
DETAIL_MAX = 200

# Fracción de segundo de cualquier longitud: Python 3.9 solo acepta 3 o 6 dígitos en fromisoformat.
_FRACTION = re.compile(r"\.(\d+)")


def _parse_expires_at(value: Any) -> Optional[float]:
    """Segundos Unix de una fecha ISO 8601 con zona horaria; None si no lo es."""
    if not isinstance(value, str) or len(value) > 64:
        return None
    text = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
    text = _FRACTION.sub(lambda m: "." + (m.group(1) + "000000")[:6], text, count=1)
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None or moment.utcoffset() is None:
        return None
    return moment.timestamp()


def _parse_command_id(value: Any) -> Optional[str]:
    """UUID en su forma canónica (minúsculas con guiones); None si no lo es."""
    if not isinstance(value, str):
        return None
    try:
        canonical = str(uuid.UUID(value))
    except ValueError:
        return None
    return canonical if canonical == value.lower() else None


class _Order:
    __slots__ = ("command_id", "output", "requested_by", "expires_at")

    def __init__(self, command_id: str, output: int, requested_by: str, expires_at: float) -> None:
        self.command_id = command_id
        self.output = output
        self.requested_by = requested_by
        self.expires_at = expires_at


def _parse(body: Mapping[str, Any]) -> Optional[_Order]:
    command_id = _parse_command_id(body.get("command_id"))
    output = body.get("output")
    requested_by = body.get("requested_by")
    expires_at = _parse_expires_at(body.get("expires_at"))
    if command_id is None or expires_at is None:
        return None
    if isinstance(output, bool) or not isinstance(output, int) or not 0 <= output <= OUTPUT_MAX:
        return None
    if not isinstance(requested_by, str) or not 1 <= len(requested_by) <= REQUESTED_BY_MAX:
        return None
    return _Order(command_id, output, requested_by, expires_at)


class CommandWorker:
    """Atiende las órdenes `test_output` en un hilo propio, una a la vez y en orden de llegada."""

    def __init__(self, daemon_request: Callable[[str, Mapping[str, Any]], Dict[str, Any]],
                 socket_path: str,
                 post_result: Callable[[str, bool, Optional[str]], None],
                 wall: Callable[[], float] = time.time) -> None:
        self._daemon_request = daemon_request
        self._socket_path = socket_path
        self._post_result = post_result
        self._wall = wall
        self._queue = queue.Queue(QUEUE_MAX)  # type: queue.Queue
        self._seen = OrderedDict()  # type: OrderedDict
        self._thread = None  # type: Optional[threading.Thread]
        self._stopping = threading.Event()

    def submit(self, body: Dict[str, Any]) -> None:
        """Pone la orden en la cola sin bloquear (corre en el hilo de MQTT)."""
        try:
            self._queue.put_nowait(body)
        except queue.Full:
            log.warning("Cola de órdenes llena: se descarta una orden de la nube")

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="cloud-commands", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Detiene el worker sin bloquear: descarta lo que quede en la cola y no llama más al daemon.

        Una orden que ya estaba en el daemon termina sola (el hilo es daemon) e intenta informar su
        resultado; stop() solo la espera STOP_WAIT_S."""
        self._stopping.set()
        thread, self._thread = self._thread, None
        if thread is None:
            return
        try:
            self._queue.put_nowait(None)  # despierta al hilo si espera en la cola vacía
        except queue.Full:
            pass  # el hilo está ocupado: al terminar verá `_stopping`
        thread.join(STOP_WAIT_S)

    def _loop(self) -> None:
        while not self._stopping.is_set():
            body = self._queue.get()
            if body is None or self._stopping.is_set():
                return
            try:
                self._handle(body)
            except Exception as exc:  # nada de una orden puede tumbar el hilo
                log.warning("Falló una orden de la nube (%s)", type(exc).__name__)

    def _handle(self, body: Mapping[str, Any]) -> None:
        order = _parse(body)
        if order is None:
            log.warning("Orden de prueba de salida inválida: se descarta")
            return
        if self._wall() > order.expires_at:
            log.info("Orden de prueba de salida %s caducada: se descarta", order.command_id)
            return
        if order.command_id in self._seen:
            log.info("Orden de prueba de salida %s repetida: se descarta", order.command_id)
            return
        self._seen[order.command_id] = True
        while len(self._seen) > SEEN_MAX:
            self._seen.popitem(last=False)
        if self._stopping.is_set():  # detenido (p. ej. revocado): ya no se activa nada
            return
        try:
            reply = self._daemon_request(self._socket_path, {
                "op": "test_output", "output": order.output, "requested_by": order.requested_by})
        except DaemonUnavailable:
            ok, detail = False, DAEMON_DOWN  # type: bool, Optional[str]
        else:
            ok = reply.get("ok") is True
            detail = reply.get("detail") if isinstance(reply.get("detail"), str) else None
        if detail is not None:
            detail = detail[:DETAIL_MAX]
        try:
            self._post_result(order.command_id, ok, detail)
        except Exception as exc:
            log.warning("No se pudo informar a la nube el resultado de la prueba de salida (%s)",
                        type(exc).__name__)
