"""Configuración del agente de nube y archivo de credenciales (/etc/acceso/cloud.env)."""
import fcntl
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Sequence, Tuple, Union

from acceso.config import ConfigError

DEFAULT_CREDENTIALS_PATH = "/etc/acceso/cloud.env"

PANEL_CODE_KEY = "CLOUD_PANEL_CODE"
DEVICE_TOKEN_KEY = "CLOUD_DEVICE_TOKEN"

_PANEL_CODE_RE = re.compile(r"^PNL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True)
class CloudSettings:
    cloud_url: str
    mqtt_url: str
    credentials_path: Path


def load_cloud_settings(
    env: Optional[Mapping[str, str]] = None, *, required: Sequence[str] = ()
) -> CloudSettings:
    if env is None:
        from dotenv import load_dotenv

        load_dotenv(os.environ.get("ACCESO_ENV_FILE", ".env"), override=False)
        credentials = (os.environ.get("CLOUD_CREDENTIALS_PATH") or "").strip() or DEFAULT_CREDENTIALS_PATH
        # CLOUD_URL y MQTT_URL viven junto a las credenciales; el entorno manda sobre el archivo.
        load_dotenv(credentials, override=False)
        env = os.environ

    missing = [name for name in required if not (env.get(name) or "").strip()]
    if missing:
        raise ConfigError("Faltan variables en el .env: " + ", ".join(missing))

    def text(name: str, default: str = "") -> str:
        return (env.get(name) or "").strip() or default

    cloud_url = text("CLOUD_URL").rstrip("/")
    if cloud_url and not cloud_url.startswith(("http://", "https://")):
        raise ConfigError("CLOUD_URL debe empezar con http:// o https://")
    return CloudSettings(
        cloud_url=cloud_url,
        mqtt_url=text("MQTT_URL"),
        credentials_path=Path(text("CLOUD_CREDENTIALS_PATH", DEFAULT_CREDENTIALS_PATH)),
    )


def _key_of(line: str) -> str:
    head = line.split("=", 1)[0].strip()
    return head[len("export "):].strip() if head.startswith("export ") else head


def _write_error(path: Union[str, Path], reason: str) -> ConfigError:
    # Nunca incluye los valores: solo la ruta y el motivo del sistema.
    return ConfigError("No se pudieron guardar las credenciales en %s: %s" % (path, reason))


def _rewrite_env(path: Union[str, Path], updates: Dict[str, Optional[str]], *, create: bool) -> None:
    """Reescribe `path` en el mismo archivo (el usuario `acceso` no puede crear archivos en /etc/acceso).

    Quita las líneas de las claves de `updates` y añade al final las que tienen valor.
    Escribe el contenido nuevo desde el inicio y recorta después, con fsync y modo 0600.
    """
    flags = os.O_RDWR | (os.O_CREAT if create else 0)
    try:
        fd = os.open(str(path), flags, 0o600)
    except FileNotFoundError:
        if create:
            raise _write_error(path, "no existe la carpeta") from None
        return  # sin archivo no hay nada que quitar
    except OSError as exc:
        raise _write_error(path, exc.strerror or type(exc).__name__) from None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        with os.fdopen(os.dup(fd), "r", encoding="utf-8", closefd=True) as reader:
            old = reader.read()
        kept: List[str] = [ln for ln in old.splitlines() if _key_of(ln) not in updates]
        kept.extend("%s=%s" % (k, v) for k, v in updates.items() if v is not None)
        data = ("\n".join(kept) + "\n" if kept else "").encode("utf-8")
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, data)
        os.ftruncate(fd, len(data))
        os.fsync(fd)
        os.fchmod(fd, 0o600)
    except OSError as exc:
        raise _write_error(path, exc.strerror or type(exc).__name__) from None
    finally:
        os.close(fd)


def save_credentials(path: Union[str, Path], panel_code: str, token: str) -> None:
    """Guarda CLOUD_PANEL_CODE y CLOUD_DEVICE_TOKEN y conserva las demás líneas."""
    if not _PANEL_CODE_RE.match(panel_code or ""):
        raise ValueError("El código del panel no tiene el formato PNL-XXXX-XXXX")
    if not _TOKEN_RE.match(token or ""):
        raise ValueError("El token del dispositivo tiene caracteres no válidos")
    _rewrite_env(path, {PANEL_CODE_KEY: panel_code, DEVICE_TOKEN_KEY: token}, create=True)


def load_credentials(path: Union[str, Path]) -> Optional[Tuple[str, str]]:
    """Lee (panel_code, token) del archivo; None si falta alguno."""
    from dotenv import dotenv_values

    values = dotenv_values(str(path))
    code = (values.get(PANEL_CODE_KEY) or "").strip()
    token = (values.get(DEVICE_TOKEN_KEY) or "").strip()
    return (code, token) if code and token else None


def clear_credentials(path: Union[str, Path]) -> None:
    """Quita las credenciales y conserva las demás líneas. Sin archivo, no hace nada."""
    _rewrite_env(path, {PANEL_CODE_KEY: None, DEVICE_TOKEN_KEY: None}, create=False)
