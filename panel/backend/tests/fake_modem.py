"""Simulador de un módulo GSM (SIM808) por comandos AT, para las pruebas del hilo `gsm`."""
import threading
from typing import Dict, List, Optional

DEFAULT_SCRIPT = {
    b"ATE0\r": b"\r\nOK\r\n",
    b"AT+CLIP=1\r": b"\r\nOK\r\n",
    b"AT+DDET=1\r": b"\r\nOK\r\n",
    b"AT+CMEE=2\r": b"\r\nOK\r\n",
    b"AT+CCWA=0\r": b"\r\nOK\r\n",
    b"AT+CREG?\r": b"\r\n+CREG: 0,1\r\n\r\nOK\r\n",
    b"AT+CSQ\r": b"\r\n+CSQ: 18,0\r\n\r\nOK\r\n",
    b"ATA\r": b"\r\nOK\r\n",
    b"ATH\r": b"\r\nOK\r\n",
}


class FakeModem:
    """Implementa `SerialPort`: responde según `script` e inyecta líneas con `push`."""

    def __init__(self, script: Optional[Dict[bytes, bytes]] = None, fail_open: bool = False,
                 read_error: Optional[Exception] = None) -> None:
        self.script = dict(DEFAULT_SCRIPT if script is None else script)
        self.fail_open = fail_open
        self.read_error = read_error  # se lanza en la siguiente lectura
        self.written = []  # type: List[bytes]
        self.closed = threading.Event()
        self.wrote = threading.Condition()
        self._buf = bytearray()
        self._cond = threading.Condition()

    def push(self, line: str) -> None:
        with self._cond:
            self._buf += b"\r\n" + line.encode() + b"\r\n"
            self._cond.notify_all()

    def read(self, size: int) -> bytes:
        with self._cond:
            if self.read_error is not None:
                exc, self.read_error = self.read_error, None
                raise exc
            if not self._buf:
                self._cond.wait(0.01)
            data = bytes(self._buf[:size])
            del self._buf[:size]
            return data

    def write(self, data: bytes) -> int:
        with self.wrote:
            self.written.append(bytes(data))
            self.wrote.notify_all()
        reply = self.script.get(bytes(data))
        if reply:
            with self._cond:
                self._buf += reply
                self._cond.notify_all()
        return len(data)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        self.closed.set()

    def wait_written(self, data: bytes, count: int = 1, timeout: float = 2.0) -> bool:
        with self.wrote:
            return self.wrote.wait_for(lambda: self.written.count(data) >= count, timeout)
