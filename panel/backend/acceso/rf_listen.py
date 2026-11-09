"""Escucha del siguiente control RF: el usuario pulsa un control nuevo y el panel captura su código.

El daemon es el único dueño del UART: `handle_event` entrega cada código RF a `offer` y la petición
del socket {"op": "listen_rf"} espera hasta LISTEN_SECONDS a que llegue uno.
"""
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Union

from .db import connect

log = logging.getLogger("acceso.rf_listen")

LISTEN_SECONDS = 10
# Los 10 s de escucha más margen para la ida y vuelta por el socket.
LISTEN_CLIENT_TIMEOUT_S = 13.0

NO_CONTROL = {"ok": False, "detail": "No se recibió ningún control."}
BUSY = {"ok": False, "detail": "Ya hay una escucha en curso."}


class RfListener:
    """Una sola escucha activa a la vez; `offer` nunca bloquea ni lanza."""

    def __init__(self, db_path: Union[str, Path],
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._db_path = db_path
        self._clock = clock
        self._cond = threading.Condition()
        self._active = False
        self._code = None  # type: Optional[int]

    def offer(self, code: int) -> bool:
        """Entrega `code` a la escucha activa; False si no hay o ya recibió uno."""
        with self._cond:
            if not self._active or self._code is not None:
                return False
            self._code = code
            self._cond.notify_all()
            return True

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Atiende {"op": "listen_rf"}: espera el siguiente código RF y dice a qué control pertenece."""
        with self._cond:
            if self._active:
                return dict(BUSY)
            self._active = True
            self._code = None
            deadline = self._clock() + LISTEN_SECONDS
            try:
                while self._code is None:
                    remaining = deadline - self._clock()
                    if remaining <= 0:
                        break
                    self._cond.wait(remaining)
                code = self._code
            finally:
                self._active = False
                self._code = None
        if code is None:
            return dict(NO_CONTROL)
        return {"ok": True, "code": code, "control": self._find_control(code)}

    def _find_control(self, code: int) -> Optional[Dict[str, Any]]:
        try:
            conn = connect(self._db_path)
            try:
                row = conn.execute(
                    "SELECT c.control_id, NULLIF(c.description, '') AS description"
                    " FROM control_buttons b JOIN controls c ON c.control_id = b.control_id"
                    " WHERE b.rf_code = ?", (code,)).fetchone()
            finally:
                conn.close()
        except sqlite3.Error as exc:
            log.warning("No se pudo buscar el control de la escucha: %s", exc)
            return None
        if row is None:
            return None
        return {"control_id": row["control_id"], "description": row["description"]}
