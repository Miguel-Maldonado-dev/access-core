"""Aplicación FastAPI: middleware de sesión, errores, API y archivos estáticos."""
from typing import Callable

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from acceso.config import Settings
from acceso.store.errors import Conflict, Invalid, NotFound
from acceso.web import auth
from acceso.web.auth import SESSION_COOKIE, read_session
from acceso.web.clock import ClockStatus, read_clock
from acceso.web.routes import cards, controls, holders, outputs, permissions, system

# Los routers de las tareas 8-10 se agregan a esta lista, antes del catch-all /api.
API_ROUTERS = [auth.router, system.router, holders.router, permissions.router, outputs.router,
               cards.router, controls.router]


def _is_public_page(path: str) -> bool:
    if "?" in path or "#" in path or any(seg in (".", "..") for seg in path.split("/")):
        return False
    return (
        path == "/login"
        or path.startswith("/login/")
        or path.startswith("/_next/")
        or path == "/favicon.ico"
    )


def _validation_text(exc: RequestValidationError) -> str:
    parts = []
    for err in exc.errors():
        if str(err.get("type", "")).startswith("value_error"):
            parts.append(str(err.get("msg", "")).replace("Value error, ", "", 1))
        else:
            loc = err.get("loc") or ("",)
            parts.append("Valor inválido en '%s'." % loc[-1])
    return " ".join(parts)


def create_app(
    settings: Settings,
    *,
    login_fail_delay: float = 1.0,
    clock_reader: Callable[[], ClockStatus] = read_clock,
) -> FastAPI:
    app = FastAPI(title="Control de acceso")
    app.state.settings = settings
    app.state.clock_reader = clock_reader
    app.state.login_fail_delay = login_fail_delay

    for exc, status in ((NotFound, 404), (Conflict, 409), (Invalid, 422)):
        def handler(request: Request, e: Exception, status: int = status):
            return JSONResponse({"detail": str(e)}, status_code=status)

        app.add_exception_handler(exc, handler)

    @app.exception_handler(RequestValidationError)
    def validation_handler(request: Request, e: RequestValidationError):
        return JSONResponse({"detail": _validation_text(e)}, status_code=422)

    @app.middleware("http")
    async def require_session(request: Request, call_next):
        # Mismo path que sirve StaticFiles (request.url.path trunca en ? y #).
        path = request.scope["path"]
        is_api = path == "/api" or path.startswith("/api/")
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

    for router in API_ROUTERS:
        app.include_router(router)

    @app.api_route(
        "/api/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        include_in_schema=False,
    )
    def api_not_found(path: str):
        return JSONResponse({"detail": "No encontrado."}, status_code=404)

    if settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(settings.static_dir), html=True), name="static")

    return app
