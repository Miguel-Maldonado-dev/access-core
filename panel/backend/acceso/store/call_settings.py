"""Configuración del módulo de llamadas (fila única)."""
import sqlite3

from acceso.db import now_ms, transaction
from acceso.store.errors import Invalid

DEFAULT_OUTPUT_MESSAGE = "La salida predeterminada debe estar entre las salidas del menú."


def get_settings(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        "SELECT enabled, mode, output_id, menu_mask, default_output, call_limit_per_minute"
        " FROM call_settings WHERE id = 1").fetchone()
    return {**dict(row), "enabled": bool(row["enabled"])}


def update_settings(conn: sqlite3.Connection, s: dict) -> None:
    """Guarda la configuración. Al desactivar, borra los teléfonos locales (y sus altas pendientes
    en la bandeja) sin encolar el borrado (la guarda se enciende solo para ese borrado; el cambio de configuración sí sube)."""
    if s["mode"] == "menu" and s["default_output"] is not None \
            and not s["menu_mask"] & (1 << s["default_output"]):
        raise Invalid(DEFAULT_OUTPUT_MESSAGE)
    with transaction(conn):
        if s.get("call_limit_per_minute") is None:
            s = {**s, "call_limit_per_minute": conn.execute(
                "SELECT call_limit_per_minute FROM call_settings WHERE id = 1").fetchone()[0]}
        conn.execute(
            "UPDATE call_settings SET enabled=?, mode=?, output_id=?, menu_mask=?, default_output=?,"
            " call_limit_per_minute=?, updated_at=?, origin='local' WHERE id=1",
            (int(s["enabled"]), s["mode"], s["output_id"], s["menu_mask"], s["default_output"],
             s["call_limit_per_minute"], now_ms()))
        if not s["enabled"]:
            conn.execute("UPDATE sync_guard SET applying=1 WHERE id=1")
            conn.execute("DELETE FROM phones")
            # Las altas o cambios de teléfonos aún sin subir ya no tienen fila: se quitan de la
            # bandeja (los borrados pendientes sí suben).
            conn.execute("DELETE FROM sync_outbox WHERE table_name = 'phones' AND op = 'upsert'")
            conn.execute("UPDATE sync_guard SET applying=0 WHERE id=1")


MODULE_DISABLED_MESSAGE = "Activa el módulo de llamadas para agregar teléfonos."


def require_enabled(conn: sqlite3.Connection) -> None:
    """Lanza Invalid (422) si el módulo de llamadas está desactivado."""
    row = conn.execute("SELECT enabled FROM call_settings WHERE id = 1").fetchone()
    if row is None or not row["enabled"]:
        raise Invalid(MODULE_DISABLED_MESSAGE)
