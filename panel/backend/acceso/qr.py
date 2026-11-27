"""Utilidades de los códigos QR: rango por dígito inicial, generación y ajustes."""
import secrets
import sqlite3
from dataclasses import dataclass
from typing import Callable, Tuple

from .constants import MAX_CODE

GENERATE_ATTEMPTS = 20


class QrCodeExhausted(Exception):
    """No se encontró un código libre en el rango tras varios intentos."""


@dataclass(frozen=True)
class QrSettings:
    digit: int
    max_active: int


def qr_range(digit: int) -> Tuple[int, int]:
    """Rango de códigos QR para el dígito inicial: 9 -> 900000000..999999999 (9 cifras);
    1-4 -> 10 cifras (el 4 se corta en MAX_CODE); 5-8 y 9 -> 9 cifras."""
    if digit <= 4:
        return digit * 1000000000, min(digit * 1000000000 + 999999999, MAX_CODE)
    return digit * 100000000, digit * 100000000 + 99999999


def looks_like_qr(code: int, digit: int) -> bool:
    low, high = qr_range(digit)
    return low <= code <= high


def secrets_randbelow_range(low: int, high: int) -> int:
    """Entero aleatorio criptográfico en [low, high] (inclusivo)."""
    return low + secrets.randbelow(high - low + 1)


def generate_code(conn: sqlite3.Connection, digit: int, *,
                  rand: Callable[[int, int], int] = secrets_randbelow_range) -> int:
    """Código libre del rango: no repite qr_codes.code ni cards.card_code."""
    low, high = qr_range(digit)
    for _ in range(GENERATE_ATTEMPTS):
        code = rand(low, high)
        taken = conn.execute(
            "SELECT 1 FROM qr_codes WHERE code=? UNION ALL SELECT 1 FROM cards WHERE card_code=?",
            (code, code)).fetchone()
        if taken is None:
            return code
    raise QrCodeExhausted("No se encontró un código QR libre; intenta de nuevo.")


def get_qr_settings(conn: sqlite3.Connection) -> QrSettings:
    row = conn.execute("SELECT digit, max_active FROM qr_settings WHERE id=1").fetchone()
    return QrSettings(digit=row[0], max_active=row[1])
