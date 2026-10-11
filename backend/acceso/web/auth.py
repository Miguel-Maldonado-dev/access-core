"""Token de sesión firmado para la cookie del panel."""
import time
from typing import Optional

from itsdangerous import URLSafeSerializer

from acceso.config import Settings

SESSION_COOKIE = "acceso_session"


def _serializer(settings: Settings) -> URLSafeSerializer:
    return URLSafeSerializer(settings.session_secret, salt="acceso-session")


def make_session_token(
    settings: Settings, username: str, *, issued_at: Optional[float] = None
) -> str:
    t = time.time() if issued_at is None else issued_at
    return _serializer(settings).dumps({"u": username, "t": t})


def read_session(
    settings: Settings, token: Optional[str], *, now: Optional[float] = None
) -> Optional[str]:
    """Usuario de la sesión, o None si el token falta, está alterado o venció."""
    if not token:
        return None
    try:
        data = _serializer(settings).loads(token)
        username, issued = data["u"], float(data["t"])
    except Exception:
        return None
    current = time.time() if now is None else now
    if not isinstance(username, str) or current - issued > settings.session_hours * 3600:
        return None
    return username
