"""Controles RF y sus botones."""
import sqlite3
import uuid
from dataclasses import dataclass
from typing import List, Optional, Sequence

from acceso.constants import CONTROL_BUTTONS, OUTPUT_COUNT
from acceso.db import now_ms, transaction
from acceso.store.errors import Conflict, Invalid, NotFound

_SELECT = (
    "SELECT k.control_id, k.holder_id, h.name AS holder_name, h.kind AS holder_kind,"
    " k.description FROM controls k JOIN holders h ON h.holder_id = k.holder_id"
)


@dataclass(frozen=True)
class ButtonData:
    rf_code: Optional[int]
    output_id: Optional[int]


def _with_buttons(conn: sqlite3.Connection, rows) -> List[dict]:
    buttons = {}
    for r in conn.execute("SELECT control_id, button, rf_code, output_id FROM control_buttons"):
        buttons.setdefault(r["control_id"], {})[r["button"]] = {
            "rf_code": r["rf_code"], "output_id": r["output_id"],
        }
    result = []
    for r in rows:
        d = dict(r)
        saved = buttons.get(d["control_id"], {})
        d["buttons"] = [
            dict(saved.get(i, {"rf_code": None, "output_id": None}))
            for i in range(CONTROL_BUTTONS)
        ]
        result.append(d)
    return result


def list_controls(conn: sqlite3.Connection, holder_id: Optional[int] = None) -> List[dict]:
    sql, params = _SELECT, []
    if holder_id is not None:
        sql += " WHERE k.holder_id = ?"
        params.append(holder_id)
    sql += " ORDER BY k.control_id"
    return _with_buttons(conn, conn.execute(sql, params).fetchall())


def get_control(conn: sqlite3.Connection, control_id: int) -> dict:
    rows = conn.execute(_SELECT + " WHERE k.control_id = ?", (control_id,)).fetchall()
    if not rows:
        raise NotFound("El control %s no existe." % control_id)
    return _with_buttons(conn, rows)[0]


def _validate(conn: sqlite3.Connection, holder_id: int, buttons: Sequence[ButtonData],
              control_id: Optional[int]) -> None:
    if conn.execute("SELECT 1 FROM holders WHERE holder_id = ?", (holder_id,)).fetchone() is None:
        raise Invalid("El titular %s no existe." % holder_id)
    if len(buttons) != CONTROL_BUTTONS:
        raise Invalid("El control debe tener exactamente %d botones." % CONTROL_BUTTONS)
    codes = [b.rf_code for b in buttons if b.rf_code is not None]
    if len(codes) != len(set(codes)):
        raise Invalid("Cada botón del control debe tener un código distinto.")
    for b in buttons:
        if b.rf_code is not None and b.output_id is not None and not 0 <= b.output_id < OUTPUT_COUNT:
            raise Invalid("La salida debe estar entre 0 y %d." % (OUTPUT_COUNT - 1))
    for code in codes:
        row = conn.execute(
            "SELECT b.control_id, h.name FROM control_buttons b"
            " JOIN controls k ON k.control_id = b.control_id"
            " JOIN holders h ON h.holder_id = k.holder_id"
            " WHERE b.rf_code = ? AND b.control_id IS NOT ?",
            (code, control_id),
        ).fetchone()
        if row is not None:
            raise Conflict(
                "El código %s ya está registrado en el control %s (%s)."
                % (code, row["control_id"], row["name"])
            )


def _set_buttons(conn: sqlite3.Connection, control_id: int, buttons: Sequence[ButtonData]) -> None:
    """Guarda los botones por diferencia: el que conserva botón y código mantiene su uuid.

    Un botón cuyo código cambia se borra y se vuelve a crear (así un intercambio de códigos entre
    botones no choca con el UNIQUE de rf_code); solo cambia la salida con UPDATE.
    """
    wanted = {i: b for i, b in enumerate(buttons) if b.rf_code is not None}
    current = {r["button"]: r for r in conn.execute(
        "SELECT button, rf_code, output_id FROM control_buttons WHERE control_id = ?",
        (control_id,))}
    for button, row in current.items():
        if button not in wanted or wanted[button].rf_code != row["rf_code"]:
            conn.execute("DELETE FROM control_buttons WHERE control_id = ? AND button = ?",
                         (control_id, button))
    stamp = now_ms()
    for button, b in wanted.items():
        row = current.get(button)
        if row is None or row["rf_code"] != b.rf_code:
            conn.execute(
                "INSERT INTO control_buttons(control_id, button, rf_code, output_id, uuid,"
                " updated_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'local')",
                (control_id, button, b.rf_code, b.output_id, str(uuid.uuid4()), stamp))
        elif row["output_id"] != b.output_id:
            conn.execute(
                "UPDATE control_buttons SET output_id = ?, updated_at = ?, origin = 'local'"
                " WHERE control_id = ? AND button = ?", (b.output_id, stamp, control_id, button))


def create_control(conn: sqlite3.Connection, holder_id: int, description: str,
                   buttons: Sequence[ButtonData]) -> int:
    with transaction(conn):
        _validate(conn, holder_id, buttons, None)
        cur = conn.execute(
            "INSERT INTO controls(holder_id, description, uuid, updated_at, origin)"
            " VALUES (?, ?, ?, ?, 'local')",
            (holder_id, description, str(uuid.uuid4()), now_ms()),
        )
        _set_buttons(conn, cur.lastrowid, buttons)
        return cur.lastrowid


def update_control(conn: sqlite3.Connection, control_id: int, holder_id: int, description: str,
                   buttons: Sequence[ButtonData]) -> None:
    with transaction(conn):
        if conn.execute("SELECT 1 FROM controls WHERE control_id = ?", (control_id,)).fetchone() is None:
            raise NotFound("El control %s no existe." % control_id)
        _validate(conn, holder_id, buttons, control_id)
        conn.execute(
            "UPDATE controls SET holder_id = ?, description = ?, updated_at = ?, origin = 'local'"
            " WHERE control_id = ?",
            (holder_id, description, now_ms(), control_id),
        )
        _set_buttons(conn, control_id, buttons)


def delete_control(conn: sqlite3.Connection, control_id: int) -> None:
    with transaction(conn):
        cur = conn.execute("DELETE FROM controls WHERE control_id = ?", (control_id,))
        if cur.rowcount == 0:
            raise NotFound("El control %s no existe." % control_id)
