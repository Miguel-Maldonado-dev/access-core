"""Socket Unix local del daemon: la web y el agente le piden acciones (una línea JSON por conexión)."""
import json
import logging
import os
import socket
import stat
import threading
import time
from typing import Any, Callable, Dict, Mapping, Optional

log = logging.getLogger("acceso.daemon_socket")

MAX_REQUEST_BYTES = 4096
CONNECTION_TIMEOUT_S = 2.0
ACCEPT_POLL_S = 0.2

INVALID_REQUEST = {"ok": False, "detail": "Petición inválida."}
INTERNAL_ERROR = {"ok": False, "detail": "Error interno."}


class DaemonUnavailable(Exception):
    """El daemon no corre, rechazó la conexión, no respondió a tiempo o respondió basura."""


def _read_line(sock: socket.socket, limit: int, deadline: float) -> Optional[bytes]:
    """Lee hasta el fin de línea o el cierre; None si se pasa de `limit` bytes.

    `deadline` (de time.monotonic) es un plazo total: un cliente que gotea bytes no lo alarga.
    Al agotarse lanza socket.timeout.
    """
    data = b""
    while b"\n" not in data:
        _settimeout_until(sock, deadline)
        chunk = sock.recv(limit + 1 - len(data))
        if not chunk:
            break
        data += chunk
        if len(data) > limit:
            return None
    return data.split(b"\n", 1)[0]


def _settimeout_until(sock: socket.socket, deadline: float) -> None:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise socket.timeout("Se agotó el plazo")
    sock.settimeout(remaining)


def _encode(message: Mapping[str, Any]) -> bytes:
    return (json.dumps(message) + "\n").encode("utf-8")


def request_daemon(path: str, payload: Mapping[str, Any], timeout: float = 7.0) -> Dict[str, Any]:
    """Envía una petición al daemon y devuelve su respuesta (objeto JSON).

    `timeout` es el plazo total. Cubre el busy_timeout de 5 s de SQLite al registrar el log y
    cabe en la vigencia de 10 s de las órdenes de la nube.
    """
    deadline = time.monotonic() + timeout
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            _settimeout_until(sock, deadline)
            sock.connect(path)
            _settimeout_until(sock, deadline)
            sock.sendall(_encode(payload))
            raw = _read_line(sock, MAX_REQUEST_BYTES, deadline)
    except OSError as exc:  # incluye FileNotFoundError, ConnectionRefusedError y socket.timeout
        raise DaemonUnavailable("El daemon no responde") from exc
    try:
        reply = json.loads(raw.decode("utf-8")) if raw else None
    except ValueError as exc:
        raise DaemonUnavailable("El daemon no responde") from exc
    if not isinstance(reply, dict):
        raise DaemonUnavailable("El daemon no responde")
    return reply


def _remove_stale_socket(path: str) -> None:
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if stat.S_ISSOCK(mode):
        os.unlink(path)


class DaemonSocketServer:
    """Atiende peticiones en su propio hilo, una a la vez y una por conexión."""

    def __init__(self, path: str, handler: Callable[[Dict[str, Any]], Dict[str, Any]]) -> None:
        self._path = path
        self._handler = handler
        self._sock = None  # type: Optional[socket.socket]
        self._thread = None  # type: Optional[threading.Thread]
        self._stop = threading.Event()

    def start(self) -> None:
        """Crea el socket (modo 0600) y arranca el hilo; lanza OSError si no se puede."""
        _remove_stale_socket(self._path)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.bind(self._path)
            # Antes de listen() nadie puede conectarse, así que no queda ventana con otro modo.
            os.chmod(self._path, 0o600)
            sock.listen(8)
            sock.settimeout(ACCEPT_POLL_S)
        except OSError:
            sock.close()
            raise
        self._sock = sock
        self._thread = threading.Thread(target=self._loop, name="daemon-socket", daemon=True)
        self._thread.start()
        log.info("Socket del daemon en %s", self._path)

    def stop(self) -> None:
        if self._sock is None:
            return
        self._stop.set()
        if self._thread is not None:
            self._thread.join(CONNECTION_TIMEOUT_S + 1)
        self._sock.close()
        self._sock = None
        try:
            _remove_stale_socket(self._path)
        except OSError:
            pass

    def _loop(self) -> None:
        sock = self._sock  # local: stop() puede poner self._sock en None mientras el hilo sigue
        if sock is None:
            return
        while not self._stop.is_set():
            try:
                conn, _ = sock.accept()
            except socket.timeout:
                continue
            except OSError as exc:
                log.warning("Error al aceptar conexiones en el socket: %s", exc)
                self._stop.wait(ACCEPT_POLL_S)
                continue
            try:
                with conn:
                    self._serve_connection(conn)
            except Exception:
                # Nada de una conexión puede tumbar el hilo: se registra y se sigue atendiendo.
                log.exception("Error inesperado en una conexión del socket")

    def _serve_connection(self, conn: socket.socket) -> None:
        # Plazo total de la conexión (lectura y respuesta), no por cada recv.
        deadline = time.monotonic() + CONNECTION_TIMEOUT_S
        try:
            raw = _read_line(conn, MAX_REQUEST_BYTES, deadline)
        except OSError:
            return  # el cliente tardó o se fue: no hay a quién responder
        reply = self._reply(raw)
        try:
            data = _encode(reply)
        except (TypeError, ValueError):
            log.exception("Respuesta del socket que no se puede convertir a JSON")
            data = _encode(INTERNAL_ERROR)
        try:
            # La respuesta lleva su propio plazo: el handler (SQLite) puede haber tardado.
            conn.settimeout(CONNECTION_TIMEOUT_S)
            conn.sendall(data)
        except OSError:
            pass

    def _reply(self, raw: Optional[bytes]) -> Dict[str, Any]:
        try:
            request = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            request = None
        if not isinstance(request, dict):
            return INVALID_REQUEST
        try:
            return self._handler(request)
        except Exception:
            log.exception("Error al atender una petición del socket")
            return INTERNAL_ERROR
