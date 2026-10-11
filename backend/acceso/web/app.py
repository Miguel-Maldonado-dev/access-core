"""Aplicación FastAPI: sesión, API y archivos estáticos de la interfaz."""
import asyncio
import hmac
from typing import Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from acceso.config import Settings
from acceso.store.errors import Conflict, Invalid, NotFound
from acceso.web.auth import SESSION_COOKIE, make_session_token, read_session
from acceso.web.clock import ClockStatus, read_clock
from acceso.web.routes import system


class LoginBody(BaseModel):
    username: str
    password: str


def _is_public_page(path: str) -> bool:
    return (
        path == "/login"
        or path.startswith("/login/")
        or path.startswith("/_next/")
        or path == "/favicon.ico"
    )


def create_app(
    settings: Settings,
    *,
    login_fail_delay: float = 1.0,
    clock_reader: Callable[[], ClockStatus] = read_clock,
) -> FastAPI:
    app = FastAPI(title="Control de acceso")
    app.state.settings = settings
    app.state.clock_reader = clock_reader

    for exc, status in ((NotFound, 404), (Conflict, 409), (Invalid, 422)):
        def handler(request: Request, e: Exception, status: int = status):
            return JSONResponse({"detail": str(e)}, status_code=status)

        app.add_exception_handler(exc, handler)

    @app.middleware("http")
    async def require_session(request: Request, call_next):
        path = request.url.path
        is_api = path == "/api" or path.startswith("/api/")
        if request.method != "OPTIONS":
            if is_api and path != "/api/login":
                user = read_session(settings, request.cookies.get(SESSION_COOKIE))
                if user is None:
                    return JSONResponse({"detail": "No autenticado"}, status_code=401)
                request.state.user = user
            elif not is_api and not _is_public_page(path):
                if read_session(settings, request.cookies.get(SESSION_COOKIE)) is None:
                    return Response(status_code=302, headers={"Location": "/login/"})
        return await call_next(request)

    if settings.cors_origins:
        # Se agrega al final para quedar como capa externa y responder los preflight.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.post("/api/login", status_code=204)
    async def login(body: LoginBody):
        ok_user = hmac.compare_digest(
            body.username.encode("utf-8"), settings.admin_user.encode("utf-8")
        )
        ok_pass = hmac.compare_digest(
            body.password.encode("utf-8"), settings.admin_password.encode("utf-8")
        )
        if not (ok_user and ok_pass):
            await asyncio.sleep(login_fail_delay)
            return JSONResponse(
                {"detail": "Usuario o contraseña incorrectos"}, status_code=401
            )
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

    @app.post("/api/logout", status_code=204)
    def logout():
        response = Response(status_code=204)
        response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="strict")
        return response

    @app.get("/api/session")
    def session(request: Request):
        return {"username": request.state.user}

    app.include_router(system.router)

    if settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(settings.static_dir), html=True), name="static")

    return app
