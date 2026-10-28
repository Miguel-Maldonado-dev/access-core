"""Identidad del panel en la nube, guardada en la tabla sync_state."""
import secrets
import sqlite3
from dataclasses import dataclass, field
from typing import Optional

from acceso.db import transaction

# Crockford base32 (sin I, L, O ni U).
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CLAIM_CODE_LENGTH = 8


@dataclass(frozen=True)
class Identity:
    panel_code: str
    claim_code: str = field(repr=False)
    panel_secret: str = field(repr=False)


def _random_text(length: int) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def new_panel_code() -> str:
    return "PNL-%s-%s" % (_random_text(4), _random_text(4))


def new_claim_code() -> str:
    return _random_text(CLAIM_CODE_LENGTH)


def new_panel_secret() -> str:
    return secrets.token_hex(32)


def get_state(conn: sqlite3.Connection, key: str, default: Optional[str] = None) -> Optional[str]:
    row = conn.execute("SELECT value FROM sync_state WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO sync_state(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def _read_identity(conn: sqlite3.Connection) -> Identity:
    return Identity(
        panel_code=get_state(conn, "panel_code") or "",
        claim_code=get_state(conn, "claim_code") or "",
        panel_secret=get_state(conn, "panel_secret") or "",
    )


def ensure_identity(conn: sqlite3.Connection) -> Identity:
    """Devuelve la identidad guardada; genera y guarda lo que falte (estable entre llamadas)."""
    with transaction(conn):
        for key, make in (
            ("panel_code", new_panel_code),
            ("claim_code", new_claim_code),
            ("panel_secret", new_panel_secret),
        ):
            if get_state(conn, key) is None:
                set_state(conn, key, make())
        if get_state(conn, "state") is None:
            set_state(conn, "state", "unlinked")
        return _read_identity(conn)


def regenerate_claim_code(conn: sqlite3.Connection) -> str:
    """Cambia solo el código de vinculación y lo devuelve."""
    ensure_identity(conn)
    code = new_claim_code()
    with transaction(conn):
        set_state(conn, "claim_code", code)
    return code
