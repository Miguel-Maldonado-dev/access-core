"""Hilo `gsm` del daemon: atiende llamadas del módulo SIM808 por comandos AT.

Una llamada a la vez. Modo "Una salida": cuelga (`ATH`) y abre la salida configurada. Modo
"Varias salidas": contesta (`ATA`) y espera una tecla DTMF 1–4 durante `CALL_MENU_TIMEOUT_S`.
Todos los tiempos usan el reloj inyectado (`clock`), para probar sin esperas reales.
"""
import logging
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from .calls import CallAuthorizer, CallLookup, CallSettings, load_call_settings
from .config import Settings
from .constants import CALL_MENU_TIMEOUT_S, OUTPUT_COUNT, RECONNECT_SECONDS, REASON_NO_PERMISSION
from .daemon import _SERIAL_ERRORS, SerialPort, open_serial_port
from .db import connect

log = logging.getLogger("acceso.gsm")

INIT_COMMANDS = ("ATE0", "AT+CLIP=1", "AT+DDET=1", "AT+CMEE=2")
OPTIONAL_INIT_COMMANDS = ("AT+CCWA=0",)  # si responde ERROR: aviso y se continúa
COMMAND_TIMEOUT_S = 2.0
STATUS_INTERVAL_S = 30.0
RING_WITHOUT_CLIP_S = 6.0   # RING sin +CLIP: se cuelga (ATH, sin log)
CALL_QUIET_S = 2.0          # tras atender, se vacían los RING/+CLIP ya en búfer (no se renueva)

_CREG = re.compile(r"^\+CREG:\s*(?:\d+\s*,\s*)?(\d+)")
_CSQ = re.compile(r"^\+CSQ:\s*(\d+)")
_DTMF = re.compile(r"^\+DTMF:\s*(\S+)")
_EOL = re.compile(rb"[\r\n]+")


class _Disabled(Exception):
    """El módulo se desactivó en `call_settings`: se cuelga y se cierra el puerto."""


class GsmService:
    def __init__(self, settings: Settings, authorizer: CallAuthorizer, *,
                 open_port: Callable[[str, int], SerialPort] = open_serial_port,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self._settings = settings
        self._authz = authorizer
        self._open_port = open_port
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._enabled = None  # type: Optional[bool]
        self._connected = False
        self._registered = None  # type: Optional[bool]
        self._signal = None  # type: Optional[int]
        # Estado de la sesión (solo lo toca el hilo `gsm`).
        self._port = None  # type: Optional[SerialPort]
        self._buf = b""
        self._pending = []  # type: List[str]
        self._call_settings = CallSettings(False, "single", 0, 0, None)
        self._last_reload = 0.0
        self._stop = threading.Event()

    # --- estado -------------------------------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        with self._lock:
            enabled = self._enabled
        if enabled is None:
            try:
                enabled = self._load().enabled
            except Exception:
                log.exception("No se pudo leer la configuración de llamadas")
        with self._lock:
            return {"ok": True, "enabled": enabled, "port": self._settings.gsm_port,
                    "connected": self._connected, "registered": self._registered,
                    "signal": self._signal}

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        return self.status()

    def _set(self, **fields: Any) -> None:
        with self._lock:
            for name, value in fields.items():
                setattr(self, "_" + name, value)

    def _load(self) -> CallSettings:
        conn = connect(self._settings.db_path)
        try:
            return load_call_settings(conn)
        finally:
            conn.close()

    def _reload(self) -> CallSettings:
        cs = self._load()
        self._call_settings = cs
        self._last_reload = self._clock()
        self._set(enabled=cs.enabled)
        return cs

    # --- ciclo principal ----------------------------------------------------------------------

    def run(self, stop: threading.Event) -> None:
        self._stop = stop
        port_name = self._settings.gsm_port
        while not stop.is_set():
            try:
                cs = self._reload()
            except Exception:
                log.exception("No se pudo leer la configuración de llamadas")
                self._sleep(RECONNECT_SECONDS)
                continue
            if not port_name or not cs.enabled:
                self._sleep(RECONNECT_SECONDS)
                continue
            try:
                port = self._open_port(port_name, self._settings.gsm_baud)
            except _SERIAL_ERRORS as exc:
                log.warning("No se pudo abrir el módulo GSM en %s: %s. Reintento en %.0f s",
                            port_name, exc, RECONNECT_SECONDS)
                self._sleep(RECONNECT_SECONDS)
                continue
            self._port, self._buf, self._pending = port, b"", []
            retry = True
            try:
                if not self._init():
                    log.warning("El módulo GSM no responde en %s", port_name)
                else:
                    log.info("Módulo GSM listo en %s", port_name)
                    self._set(connected=True)
                    self._session()
                    retry = False
            except _Disabled:
                log.info("Llamadas desactivadas: se cierra el módulo GSM")
                retry = False
            except _SERIAL_ERRORS as exc:
                log.warning("Error en el módulo GSM: %s. Reconectando en %.0f s",
                            exc, RECONNECT_SECONDS)
            except Exception:
                log.exception("Error inesperado en el hilo gsm")
            finally:
                self._port = None
                self._set(connected=False, registered=None, signal=None)
                try:
                    port.close()
                except _SERIAL_ERRORS:
                    pass
            if retry and not stop.is_set():
                self._sleep(RECONNECT_SECONDS)

    def _init(self) -> bool:
        if not all(self._command(cmd) is not None for cmd in INIT_COMMANDS):
            return False
        for cmd in OPTIONAL_INIT_COMMANDS:
            if self._command(cmd) is None:
                log.warning("El módulo GSM no aceptó %s; se continúa sin él", cmd)
        return True

    def _session(self) -> None:
        """Atiende llamadas hasta `stop` o hasta que se desactive (lanza `_Disabled`)."""
        self._poll_status()
        next_poll = self._clock() + STATUS_INTERVAL_S
        ringing_since = None  # type: Optional[float]
        quiet_until = None  # type: Optional[float]
        while not self._stop.is_set():
            now = self._clock()
            line = self._next_line()
            if quiet_until is not None and now >= quiet_until:
                quiet_until = None
            if line is None:
                if ringing_since is not None and now - ringing_since >= RING_WITHOUT_CLIP_S:
                    ringing_since = None
                    self._hang_up()
                if now - self._last_reload >= RECONNECT_SECONDS:
                    if not self._reload().enabled:
                        return
                if ringing_since is None and quiet_until is None and now >= next_poll:
                    self._poll_status()
                    next_poll = self._clock() + STATUS_INTERVAL_S
                continue
            if line == "NO CARRIER":
                ringing_since = quiet_until = None
            elif quiet_until is not None and (line == "RING" or line.startswith("+CLIP:")):
                pass  # restos de la llamada recién atendida; el plazo no se renueva
            elif line == "RING":
                if ringing_since is None:
                    ringing_since = now
            elif line.startswith("+CLIP:"):
                ringing_since = None
                if self._handle_call(line[len("+CLIP:"):].strip()):
                    quiet_until = self._clock() + CALL_QUIET_S

    # --- llamadas -----------------------------------------------------------------------------

    def _handle_call(self, raw_clip: str) -> bool:
        """Atiende una llamada; True si sigue sonando (se ignoran sus RING hasta NO CARRIER)."""
        cs = self._call_settings
        lookup = self._authz.identify(raw_clip)
        reason = self._authz.pre_check(lookup, cs)
        if reason is not None:
            self._hang_up()
            self._authz.reject(lookup, reason)
            return True
        if cs.mode != "menu":
            self._hang_up()
            self._authz.open(lookup, cs.output_id, None)
            return True
        allowed = self._authz.menu_outputs(lookup, cs)
        if not allowed:
            self._hang_up()
            self._authz.reject(lookup, REASON_NO_PERMISSION)
            return True
        return self._menu(lookup, cs, allowed)

    def _menu(self, lookup: CallLookup, cs: CallSettings, allowed: frozenset) -> bool:
        self._command("ATA")
        deadline = self._clock() + CALL_MENU_TIMEOUT_S
        last_key = None  # type: Optional[int]
        while not self._stop.is_set():
            now = self._clock()
            line = self._next_line()
            if line is None:
                if now - self._last_reload >= RECONNECT_SECONDS:
                    if not self._reload().enabled:
                        self._hang_up()
                        raise _Disabled()
                if now >= deadline:
                    break
                continue
            if line == "NO CARRIER":
                self._finish_without_key(lookup, cs, allowed, last_key)
                return False
            if line == "RING" or line.startswith("+CLIP:") or line.startswith("+CCWA:"):
                # Otra llamada mientras se atiende una: se cuelga sin registrar la nueva.
                self._hang_up()
                self._finish_without_key(lookup, cs, allowed, last_key)
                return True
            match = _DTMF.match(line)
            if not match:
                continue
            key = match.group(1)
            if key.isdigit():
                number = int(key)
                if 1 <= number <= OUTPUT_COUNT and (number - 1) in allowed:
                    self._authz.open(lookup, number - 1, number)
                    self._hang_up()
                    return True
                last_key = number
        else:
            self._hang_up()
            return True
        self._hang_up()
        self._finish_without_key(lookup, cs, allowed, last_key)
        return True

    def _finish_without_key(self, lookup: CallLookup, cs: CallSettings, allowed: frozenset,
                            key: Optional[int]) -> None:
        default = cs.default_output
        if default is not None and default in allowed and cs.menu_mask & (1 << default):
            self._authz.open(lookup, default, key)
        else:
            self._authz.reject(lookup, REASON_NO_PERMISSION, key)

    def _hang_up(self) -> None:
        self._command("ATH")

    # --- AT -----------------------------------------------------------------------------------

    def _poll_status(self) -> None:
        creg = self._command("AT+CREG?")
        csq = self._command("AT+CSQ")
        registered = signal = None  # type: Optional[Any]
        for line in creg or []:
            match = _CREG.match(line)
            if match:
                registered = match.group(1) in ("1", "5")
        for line in csq or []:
            match = _CSQ.match(line)
            if match:
                rssi = int(match.group(1))
                signal = None if rssi == 99 else rssi
        self._set(registered=registered, signal=signal)

    def _command(self, command: str) -> Optional[List[str]]:
        """Escribe `command` y espera `OK` (o `ERROR`) 2 s; devuelve las líneas de respuesta.

        Las notificaciones (RING, +CLIP, +DTMF, NO CARRIER) quedan en la cola para el ciclo.
        """
        assert self._port is not None
        self._port.write(command.encode() + b"\r")
        self._port.flush()
        deadline = self._clock() + COMMAND_TIMEOUT_S
        lines = []  # type: List[str]
        while not self._stop.is_set():
            now = self._clock()
            line = self._read_line()
            if line is None:
                if now >= deadline:
                    return None
                continue
            if line == "OK" or line == "ERROR" or line.startswith("+CME ERROR"):
                return lines if line == "OK" else None
            if (line in ("RING", "NO CARRIER") or line.startswith("+CLIP:")
                    or line.startswith("+DTMF:") or line.startswith("+CCWA:")):
                self._pending.append(line)
            else:
                lines.append(line)
        return None

    def _next_line(self) -> Optional[str]:
        if self._pending:
            return self._pending.pop(0)
        return self._read_line()

    def _read_line(self) -> Optional[str]:
        """Una línea completa del módulo, o None si no llegó ninguna en esta lectura."""
        assert self._port is not None
        while True:
            match = _EOL.search(self._buf)
            if match:
                raw, self._buf = self._buf[:match.start()], self._buf[match.end():]
                line = raw.decode("ascii", "replace").strip()
                if line:
                    return line
                continue
            data = self._port.read(64)
            if not data:
                return None
            self._buf += data
