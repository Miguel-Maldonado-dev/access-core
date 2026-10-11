import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

from fastapi import Depends
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from acceso.store.errors import Conflict, Invalid, NotFound
from acceso.web.app import create_app
from acceso.web.deps import get_conn
from acceso.web.auth import SESSION_COOKIE, make_session_token, read_session

LOGIN = {"username": "admin", "password": "secreto"}


def test_login_sets_strict_httponly_cookie(anon_client):
    r = anon_client.post("/api/login", json=LOGIN)
    assert r.status_code == 204
    cookie = r.headers["set-cookie"]
    assert "acceso_session=" in cookie
    assert "httponly" in cookie.lower()
    assert "samesite=strict" in cookie.lower()
    assert "Max-Age=43200" in cookie


def test_wrong_password_is_401_after_delay(settings):
    c = TestClient(create_app(settings, login_fail_delay=0.2))
    t0 = time.monotonic()
    r = c.post("/api/login", json={"username": "admin", "password": "mal"})
    assert time.monotonic() - t0 >= 0.2
    assert r.status_code == 401
    assert r.json() == {"detail": "Usuario o contraseña incorrectos"}


def test_api_requires_session(anon_client, client):
    r = anon_client.get("/api/session")
    assert r.status_code == 401
    assert r.json() == {"detail": "No autenticado"}
    r = client.get("/api/session")
    assert r.status_code == 200
    assert r.json() == {"username": "admin"}


def test_tampered_or_expired_cookie_is_401(app, settings):
    good = make_session_token(settings, "admin")
    c = TestClient(app, follow_redirects=False)
    mid = len(good) // 2  # carácter central: cambiarlo siempre invalida la firma
    c.cookies.set(SESSION_COOKIE, good[:mid] + ("A" if good[mid] != "A" else "B") + good[mid + 1:])
    assert c.get("/api/session").status_code == 401
    old = make_session_token(settings, "admin", issued_at=time.time() - 13 * 3600)
    c2 = TestClient(app, follow_redirects=False)
    c2.cookies.set(SESSION_COOKIE, old)
    assert c2.get("/api/session").status_code == 401
    assert read_session(settings, old) is None
    assert c2.get("/titulares/").status_code == 302


def test_logout_ends_session(client):
    assert client.post("/api/logout").status_code == 204
    assert client.get("/api/session").status_code == 401


def test_pages_redirect_without_session(anon_client, client):
    r = anon_client.get("/titulares/")
    assert r.status_code == 302
    assert r.headers["location"] == "/login/"
    assert anon_client.get("/login/").status_code == 200
    assert anon_client.get("/_next/static/x.js").status_code == 200
    r = client.get("/titulares/")
    assert r.status_code == 200
    assert r.text == "<html>titulares</html>"


def test_cors_only_when_configured(settings):
    headers = {
        "Origin": "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    }
    with_cors = create_app(
        replace(settings, cors_origins=("http://localhost:3000",)), login_fail_delay=0
    )
    r = TestClient(with_cors).options("/api/login", headers=headers)
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert r.headers["access-control-allow-credentials"] == "true"
    r = TestClient(create_app(settings, login_fail_delay=0)).options("/api/login", headers=headers)
    assert "access-control-allow-origin" not in r.headers
    assert "access-control-allow-credentials" not in r.headers


def test_dot_segments_do_not_bypass_login(anon_client):
    # Formas codificadas: httpx no las normaliza y llegan decodificadas a la app.
    for path in (
        "/login/%2e%2e/titulares/",
        "/login/%3F/%2e%2e/%2e%2e/titulares/",
        "/login/%23/%2e%2e/%2e%2e/titulares/",
        "/_next/%3F/%2e%2e/%2e%2e/titulares/index.html",
        "/favicon.ico%3F/%2e%2e/titulares/",
    ):
        r = anon_client.get(path)
        assert r.status_code == 302, path
        assert r.headers["location"] == "/login/"


def test_options_without_session_is_still_401(anon_client):
    assert anon_client.options("/api/session").status_code == 401


def test_lone_surrogate_login_is_401(settings):
    c = TestClient(create_app(settings, login_fail_delay=0))
    r = c.post(
        "/api/login",
        content=b'{"username":"\\ud800","password":"x"}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 401


def test_token_for_other_user_is_rejected(settings):
    token = make_session_token(settings, "admin")
    assert read_session(settings, token) == "admin"
    assert read_session(replace(settings, admin_user="otro"), token) is None


def test_domain_errors_map_to_status(app, client):
    def raiser(exc):
        def route():
            raise exc
        return route

    for name, exc in (("nf", NotFound("no hay")), ("cf", Conflict("choca")), ("iv", Invalid("mal"))):
        app.router.routes.insert(0, APIRoute("/api/t/" + name, raiser(exc)))
    for name, code, msg in (("nf", 404, "no hay"), ("cf", 409, "choca"), ("iv", 422, "mal")):
        r = client.get("/api/t/" + name)
        assert (r.status_code, r.json()) == (code, {"detail": msg})


def test_no_static_dir_pages(settings):
    app = create_app(replace(settings, static_dir=settings.static_dir / "nope"), login_fail_delay=0)
    c = TestClient(app, follow_redirects=False)
    r = c.get("/titulares/")
    assert r.status_code == 302 and r.headers["location"] == "/login/"
    c.post("/api/login", json=LOGIN)
    assert c.get("/titulares/").status_code == 404


def test_validation_error_is_spanish_string(client):
    r = client.post("/api/login", json={"username": "admin"})
    assert r.status_code == 422
    assert isinstance(r.json()["detail"], str) and "password" in r.json()["detail"]


def test_unknown_api_path_is_json_404(client):
    r = client.get("/api/no-existe")
    assert r.status_code == 404
    assert r.json() == {"detail": "No encontrado."}


def test_get_conn_works_across_threads(app, client, db):
    # `db` crea el esquema antes: el archivo ya está en WAL (como en producción tras migrar).
    async def probe_async(conn=Depends(get_conn)):
        return {"n": conn.execute("SELECT 1").fetchone()[0]}

    def probe_sync(conn=Depends(get_conn)):
        return {"n": conn.execute("SELECT 1").fetchone()[0]}

    app.router.routes.insert(0, APIRoute("/api/t/async", probe_async))
    app.router.routes.insert(0, APIRoute("/api/t/sync", probe_sync))
    cookies = dict(client.cookies)

    def hit(i):
        c = TestClient(app)
        c.cookies.update(cookies)
        return c.get("/api/t/" + ("async" if i % 2 else "sync")).status_code

    with ThreadPoolExecutor(24) as pool:
        assert set(pool.map(hit, range(48))) == {200}
