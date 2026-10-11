import time
from dataclasses import replace

from fastapi.testclient import TestClient

from acceso.web.app import create_app
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
    c.cookies.set(SESSION_COOKIE, good[:-1] + ("A" if good[-1] != "A" else "B"))
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
