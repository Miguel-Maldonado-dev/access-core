"""Números de teléfono: normalización del CLIP y captura (10 dígitos, México)."""
import re
from typing import Optional

_NON_DIGITS = re.compile(r"\D")


def normalize_phone(raw: str) -> Optional[str]:
    """Número del CLIP a 10 dígitos: quita lo que no sea dígito y el prefijo 521 o 52."""
    digits = _NON_DIGITS.sub("", raw or "")
    if len(digits) == 13 and digits.startswith("521"):
        return digits[-10:]
    if len(digits) == 12 and digits.startswith("52"):
        return digits[-10:]
    if len(digits) == 10:
        return digits
    return None


def parse_phone_input(raw: str) -> str:
    """Número capturado por una persona: sin espacios ni guiones, exactamente 10 dígitos."""
    cleaned = re.sub(r"[\s-]", "", raw or "")
    if len(cleaned) != 10 or not (cleaned.isascii() and cleaned.isdigit()):
        raise ValueError("El número debe tener 10 dígitos.")
    return cleaned
