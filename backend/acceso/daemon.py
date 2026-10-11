"""Daemon de control de acceso: lee tramas del ATmega por UART y acciona los relevadores."""
import logging
import signal
import sys
import termios
import threading
import time
from typing import Callable, Protocol

from .access import handle_event
from .config import ConfigError, Settings, load_settings
from .constants import RECONNECT_SECONDS
from .db import connect
from .migrate import MigrationError, migrate
from .protocol import FrameParser, InvalidFrame

log = logging.getLogger("acceso.daemon")

# pyserial lanza termios.error (que no es OSError) en flush() y a veces al leer.
_SERIAL_ERRORS = (OSError, termios.error)


class SerialPort(Protocol):
    def read(self, size: int) -> bytes: ...
    def write(self, data: bytes) -> int: ...
    def flush(self) -> None: ...
    def close(self) -> None: ...


def open_serial_port(port: str, baud: int) -> SerialPort:
    import serial

    return serial.Serial(port, baud, timeout=0.1)


def _make_send(port: SerialPort) -> Callable[[bytes], None]:
    def send(frame: bytes) -> None:
        try:
            port.write(frame)
            port.flush()
        except _SERIAL_ERRORS as exc:
            raise OSError("Error al escribir en el puerto serie: %s" % exc) from exc

    return send


def _serve(settings: Settings, conn, port: SerialPort, stop: threading.Event) -> None:
    """Procesa tramas hasta `stop` o hasta que el puerto falle (lanza OSError/termios.error)."""
    parser = FrameParser()
    send = _make_send(port)
    while not stop.is_set():
        data = port.read(64)
        if not data:
            continue
        for item in parser.feed(data):
            if isinstance(item, InvalidFrame):
                log.warning("Trama inválida descartada (%s): %s", item.reason, item.raw.hex())
                continue
            handle_event(conn, item, send, max_entries=settings.log_max_entries)


def run_daemon(settings: Settings, stop: threading.Event, *,
               open_serial: Callable[[str, int], SerialPort] = open_serial_port,
               sleep: Callable[[float], None] = time.sleep) -> None:
    conn = connect(settings.db_path)
    try:
        while not stop.is_set():
            try:
                port = open_serial(settings.uart_port, settings.uart_baud)
            except _SERIAL_ERRORS as exc:
                log.warning("No se pudo abrir %s: %s. Reintento en %.0f s",
                            settings.uart_port, exc, RECONNECT_SECONDS)
                sleep(RECONNECT_SECONDS)
                continue
            log.info("Puerto %s abierto", settings.uart_port)
            try:
                _serve(settings, conn, port, stop)
            except _SERIAL_ERRORS as exc:
                log.warning("Error en el puerto serie: %s. Reconectando en %.0f s",
                            exc, RECONNECT_SECONDS)
                sleep(RECONNECT_SECONDS)
            finally:
                try:
                    port.close()
                except _SERIAL_ERRORS:
                    pass
    finally:
        conn.close()


def main() -> None:
    logging.basicConfig(stream=sys.stdout, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = load_settings(required=("UART_PORT",))
        migrate(settings.db_path)
    except (ConfigError, MigrationError) as exc:
        log.error("%s", exc)
        sys.exit(1)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    log.info("Daemon iniciado")
    run_daemon(settings, stop, sleep=stop.wait)
    log.info("Daemon detenido")


if __name__ == "__main__":
    main()
