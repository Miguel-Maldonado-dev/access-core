"""Órdenes de la nube que el agente ejecuta en su propio hilo: `test_output`, `remote_open` y `listen_rf`.

La orden llega por MQTT (`acc/<panel_code>/cmd`), se valida, se descarta si ya caducó o si su
`command_id` ya se vio, y se pasa al daemon por su socket local. El resultado se informa a la nube
con `POST /api/device/v1/command-result`. Una orden inválida, caducada o repetida se descarta sin
informar: la nube la deja vencer. De una excepción inesperada solo se registra el tipo.
`remote_open` exige además `holder_uuid` (UUID canónico) e informa el motivo (`reason`) del daemon.
`listen_rf` no lleva `output` ni `requested_by`: el daemon espera hasta 10 s el siguiente control RF y
el código recibido se informa como `rf_code`. Va en un worker aparte (espera mucho) para no retrasar
las aperturas remotas.
"""
import logging
import queue
import re
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from typing import Any, Callable, Dict, FrozenSet, Iterable, Mapping, Optional

from acceso.daemon_socket import DaemonUnavailable

log = logging.getLogger("acceso.cloud")

OUTPUT_MAX = 3
REQUESTED_BY_MAX = 120
# Las órdenes viven 10 s en la nube (13 s la escucha): 256 identificadores cubren de sobra esa vigencia.
SEEN_MAX = 256
QUEUE_MAX = 64
# stop() no espera a una orden en curso (hasta 7 s del daemon, 13 s la escucha, más la llamada a la nube).
STOP_WAIT_S = 0.2
DAEMON_DOWN = "El daemon no responde"
# La nube rechaza un `detail` de más de 200 caracteres.
DETAIL_MAX = 200
TEST_OUTPUT = "test_output"
REMOTE_OPEN = "remote_open"
LISTEN_RF = "listen_rf"
WORKER_COMMANDS = frozenset((TEST_OUTPUT, REMOTE_OPEN))
LISTEN_COMMANDS = frozenset((LISTEN_RF,))
# Plazo del socket del daemon para las órdenes cortas (el de `request_daemon` por omisión).
DEFAULT_TIMEOUT_S = 7.0
RF_CODE_MAX = 4294967295

# Fracción de segundo de cualquier longitud: Python 3.9 solo acepta 3 o 6 dígitos en fromisoformat.
_FRACTION = re.compile(r"\.(\d+)")


def parse_iso_utc(value: Any) -> Optional[float]:
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


def _parse_uuid(value: Any) -> Optional[str]:
    """UUID en su forma canónica (minúsculas con guiones); None si no lo es."""
    if not isinstance(value, str):
        return None
    try:
        canonical = str(uuid.UUID(value))
    except ValueError:
        return None
    return canonical if canonical == value.lower() else None


class _Order:
    __slots__ = ("kind", "command_id", "output", "requested_by", "expires_at", "holder_uuid")

    def __init__(self, kind: str, command_id: str, output: int, requested_by: str, expires_at: float,
                 holder_uuid: Optional[str] = None) -> None:
        self.kind = kind
        self.command_id = command_id
        self.output = output
        self.requested_by = requested_by
        self.expires_at = expires_at
        self.holder_uuid = holder_uuid


def _parse(body: Mapping[str, Any], kinds: FrozenSet[str] = WORKER_COMMANDS) -> Optional[_Order]:
    kind = body.get("type")
    if kind not in kinds:
        return None
    command_id = _parse_uuid(body.get("command_id"))
    output = body.get("output")
    requested_by = body.get("requested_by")
    expires_at = parse_iso_utc(body.get("expires_at"))
    if command_id is None or expires_at is None:
        return None
    if kind == LISTEN_RF:
        return _Order(kind, command_id, 0, "", expires_at)
    if isinstance(output, bool) or not isinstance(output, int) or not 0 <= output <= OUTPUT_MAX:
        return None
    if not isinstance(requested_by, str) or not 1 <= len(requested_by) <= REQUESTED_BY_MAX:
        return None
    holder_uuid = None  # type: Optional[str]
    if kind == REMOTE_OPEN:
        holder_uuid = _parse_uuid(body.get("holder_uuid"))
        if holder_uuid is None:
            return None
    return _Order(kind, command_id, output, requested_by, expires_at, holder_uuid)


def _request(order: _Order) -> Dict[str, Any]:
    """Petición al daemon por su socket local."""
    if order.kind == LISTEN_RF:
        return {"op": LISTEN_RF}
    payload = {"op": order.kind, "output": order.output}  # type: Dict[str, Any]
    if order.kind == REMOTE_OPEN:
        payload["holder_uuid"] = order.holder_uuid
    payload["requested_by"] = order.requested_by
    return payload


def _reason(order: _Order, reply: Mapping[str, Any]) -> Optional[int]:
    """Motivo del daemon en `remote_open`; None en `test_output` o si no es un entero (p. ej. la
    respuesta INVALID_REQUEST no lo trae)."""
    reason = reply.get("reason")
    if order.kind != REMOTE_OPEN or isinstance(reason, bool) or not isinstance(reason, int):
        return None
    return reason


def _rf_code(reply: Mapping[str, Any]) -> Optional[int]:
    """Código RF de la respuesta de `listen_rf`; None si no es un entero de 32 bits sin signo."""
    code = reply.get("code")
    if isinstance(code, bool) or not isinstance(code, int) or not 0 <= code <= RF_CODE_MAX:
        return None
    return code


class CommandWorker:
    """Atiende las órdenes de los tipos `kinds` en un hilo propio, una a la vez y en orden de
    llegada. La deduplicación por `command_id` y la caducidad son comunes a todos los tipos.
    `timeout` es el plazo de la petición al daemon."""

    def __init__(self, daemon_request: Callable[..., Dict[str, Any]],
                 socket_path: str,
                 post_result: Callable[[str, bool, Optional[str], Optional[int], Optional[int]], None],
                 wall: Callable[[], float] = time.time,
                 kinds: Iterable[str] = WORKER_COMMANDS,
                 timeout: float = DEFAULT_TIMEOUT_S) -> None:
        self._kinds = frozenset(kinds)
        self._timeout = timeout
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
        name = "cloud-listen" if self._kinds == LISTEN_COMMANDS else "cloud-commands"
        self._thread = threading.Thread(target=self._loop, name=name, daemon=True)
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
        order = _parse(body, self._kinds)
        if order is None:
            log.warning("Orden de la nube inválida: se descarta")
            return
        if self._wall() > order.expires_at:
            log.info("Orden %s %s caducada: se descarta", order.kind, order.command_id)
            return
        if order.command_id in self._seen:
            log.info("Orden %s %s repetida: se descarta", order.kind, order.command_id)
            return
        self._seen[order.command_id] = True
        while len(self._seen) > SEEN_MAX:
            self._seen.popitem(last=False)
        if self._stopping.is_set():  # detenido (p. ej. revocado): ya no se activa nada
            return
        try:
            reply = self._daemon_request(self._socket_path, _request(order), timeout=self._timeout)
        except DaemonUnavailable:
            ok, detail, reason = False, DAEMON_DOWN, None  # type: bool, Optional[str], Optional[int]
            rf_code = None  # type: Optional[int]
        else:
            ok = reply.get("ok") is True
            detail = reply.get("detail") if isinstance(reply.get("detail"), str) else None
            reason = _reason(order, reply)
            rf_code = None
            if order.kind == LISTEN_RF and ok:
                rf_code = _rf_code(reply)
                ok, detail = rf_code is not None, (None if rf_code is not None else "Código RF inválido")
        if detail is not None:
            detail = detail[:DETAIL_MAX]
        try:
            self._post_result(order.command_id, ok, detail, reason, rf_code)
        except Exception as exc:
            log.warning("No se pudo informar a la nube el resultado de la orden %s (%s)",
                        order.kind, type(exc).__name__)
