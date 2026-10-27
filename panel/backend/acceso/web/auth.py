"""Token de sesión firmado para la cookie del panel."""
import asyncio
import hmac
import time
from typing import Optional

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from itsdangerous import URLSafeSerializer
from pydantic import BaseModel

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
    if username != settings.admin_user or current - issued > settings.session_hours * 3600:
        return None
    return username


class LoginBody(BaseModel):
    username: str
    password: str


def _same(a: str, b: str) -> bool:
    return hmac.compare_digest(
        a.encode("utf-8", "surrogatepass"), b.encode("utf-8", "surrogatepass")
    )


router = APIRouter()


@router.post("/api/login", status_code=204)
async def login(body: LoginBody, request: Request):
    settings = request.app.state.settings
    ok_user = _same(body.username, settings.admin_user)
    ok_pass = _same(body.password, settings.admin_password)
    if not (ok_user and ok_pass):
        await asyncio.sleep(request.app.state.login_fail_delay)
        return JSONResponse({"detail": "Usuario o contraseña incorrectos"}, status_code=401)
    response = Response(status_code=204)
    response.set_cookie(
        SESSION_COOKIE,
        make_session_token(settings, settings.admin_user),
        max_age=settings.session_hours * 3600,
        httponly=True,
        samesite="strict",
        path="/",
    )
    return response


@router.post("/api/logout", status_code=204)
def logout():
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="strict")
    return response


@router.get("/api/session")
def session(request: Request):
    return {"username": request.state.user}
