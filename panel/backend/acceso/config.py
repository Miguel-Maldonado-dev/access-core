"""Configuración del panel: lectura de variables desde el .env o el entorno."""
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional, Sequence, Tuple

import acceso


class ConfigError(Exception):
    """Configuración faltante o inválida."""


@dataclass(frozen=True)
class Settings:
    uart_port: str
    uart_baud: int
    admin_user: str
    admin_password: str
    session_secret: str
    web_host: str
    web_port: int
    db_path: Path
    log_max_entries: int
    session_hours: int
    cors_origins: Tuple[str, ...]
    static_dir: Path
    # Con valor por omisión y al final: tests/conftest.py construye Settings a mano.
    daemon_socket: str = "/run/acceso/daemon.sock"


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ConfigError("%s debe ser un número entero" % name)


def load_settings(
    env: Optional[Mapping[str, str]] = None, *, required: Sequence[str] = ()
) -> Settings:
    if env is None:
        from dotenv import load_dotenv

        load_dotenv(os.environ.get("ACCESO_ENV_FILE", ".env"), override=False)
        env = os.environ

    missing = [name for name in required if not (env.get(name) or "").strip()]
    if missing:
        raise ConfigError("Faltan variables en el .env: " + ", ".join(missing))

    def text(name: str, default: str = "") -> str:
        return (env.get(name) or "").strip() or default

    origins = tuple(o.strip() for o in text("CORS_ORIGINS").split(",") if o.strip())
    default_static = Path(acceso.__file__).parent / "web" / "static"
    return Settings(
        uart_port=text("UART_PORT"),
        uart_baud=_int(env, "UART_BAUD", 115200),
        admin_user=text("ADMIN_USER"),
        admin_password=env.get("ADMIN_PASSWORD") or "",
        session_secret=env.get("SESSION_SECRET") or "",
        web_host=text("WEB_HOST", "0.0.0.0"),
        web_port=_int(env, "WEB_PORT", 8080),
        db_path=Path(text("DB_PATH", "data/access_control.sqlite")),
        log_max_entries=_int(env, "LOG_MAX_ENTRIES", 100000),
        session_hours=_int(env, "SESSION_HOURS", 12),
        cors_origins=origins,
        static_dir=Path(text("STATIC_DIR")) if text("STATIC_DIR") else default_static,
        daemon_socket=text("DAEMON_SOCKET", "/run/acceso/daemon.sock"),
    )
