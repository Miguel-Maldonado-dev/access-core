"""Protocolo UART v2.2 con el ATmega: analizador de tramas y constructor de comandos."""
from dataclasses import dataclass
from typing import List, Union

SOF = 0xAA
EOF_MARKER = 0x55
CMD_CARD_READ = 0x10
CMD_RF_READ = 0x11
CMD_EXIT_BUTTON = 0x12
CMD_PIN_READ = 0x13
CMD_ACTIVATE_RELAY = 0x20

# Longitud total de la trama (SOF .. EOF) por comando.
FRAME_LENGTHS = {CMD_CARD_READ: 9, CMD_RF_READ: 8, CMD_EXIT_BUTTON: 5, CMD_PIN_READ: 12}
MAX_READER = 3
MAX_EXIT_BUTTON = 1
MAX_RELAY = 3
MAX_PIN_DIGITS = 6


def checksum(data: bytes) -> int:
    result = 0
    for byte in data:
        result ^= byte
    return result


@dataclass(frozen=True)
class CardRead:
    reader: int
    code: int


@dataclass(frozen=True)
class RfRead:
    code: int


@dataclass(frozen=True)
class ExitButton:
    button: int


@dataclass(frozen=True)
class PinRead:
    reader: int
    pin: str


@dataclass(frozen=True)
class InvalidFrame:
    raw: bytes
    reason: str


Event = Union[CardRead, RfRead, ExitButton, PinRead]


def _decode_pin(raw: bytes) -> Union[PinRead, InvalidFrame]:
    reader, length, digits = raw[2], raw[3], raw[4:10]
    if reader > MAX_READER:
        return InvalidFrame(raw, "lector %d fuera de rango" % reader)
    if not 1 <= length <= MAX_PIN_DIGITS:
        return InvalidFrame(raw, "longitud de PIN %d fuera de rango" % length)
    if any(d > 9 for d in digits[:length]):
        return InvalidFrame(raw, "dígito de PIN fuera de rango")
    if any(digits[length:]):
        return InvalidFrame(raw, "relleno de PIN distinto de cero")
    return PinRead(reader, "".join(str(d) for d in digits[:length]))


def _decode(raw: bytes) -> Union[Event, InvalidFrame]:
    if raw[-1] != EOF_MARKER:
        return InvalidFrame(raw, "eof")
    if checksum(raw[1:-2]) != raw[-2]:
        return InvalidFrame(raw, "checksum")
    cmd = raw[1]
    if cmd == CMD_CARD_READ:
        reader = raw[2]
        if reader > MAX_READER:
            return InvalidFrame(raw, "lector %d fuera de rango" % reader)
        return CardRead(reader, int.from_bytes(raw[3:7], "big"))
    if cmd == CMD_RF_READ:
        return RfRead(int.from_bytes(raw[2:6], "big"))
    if cmd == CMD_PIN_READ:
        return _decode_pin(raw)
    button = raw[2]
    if button > MAX_EXIT_BUTTON:
        return InvalidFrame(raw, "botón de salida %d fuera de rango" % button)
    return ExitButton(button)


class FrameParser:
    def __init__(self) -> None:
        self._buf = bytearray()
        self._length = 0

    def feed(self, data: bytes) -> List[Union[Event, InvalidFrame]]:
        out: List[Union[Event, InvalidFrame]] = []
        pending = bytearray(data)
        while pending:
            byte = pending.pop(0)
            if not self._buf:
                if byte == SOF:
                    self._buf.append(byte)
                continue
            if len(self._buf) == 1:
                if byte in FRAME_LENGTHS:
                    self._buf.append(byte)
                    self._length = FRAME_LENGTHS[byte]
                elif byte != SOF:
                    self._buf.clear()
                continue
            self._buf.append(byte)
            if len(self._buf) == self._length:
                raw = bytes(self._buf)
                self._buf.clear()
                result = _decode(raw)
                out.append(result)
                if isinstance(result, InvalidFrame) and result.reason in ("eof", "checksum"):
                    # Trama truncada: re-escanear tras el SOF original por el siguiente inicio.
                    start = raw.find(SOF, 1)
                    if start != -1:
                        pending[0:0] = raw[start:]
        return out


def build_relay_command(relay: int, duration_ms: int) -> bytes:
    if not 0 <= relay <= MAX_RELAY or not 0 <= duration_ms <= 0xFFFF:
        raise ValueError("Salida o duración inválida.")
    body = bytes((CMD_ACTIVATE_RELAY, relay)) + duration_ms.to_bytes(2, "big")
    return bytes((SOF,)) + body + bytes((checksum(body), EOF_MARKER))
