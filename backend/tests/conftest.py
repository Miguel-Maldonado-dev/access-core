import pytest

from acceso.db import connect
from acceso.schema import create_schema


@pytest.fixture
def conn(tmp_path):
    connection = connect(tmp_path / "test.sqlite")
    create_schema(connection)
    yield connection
    connection.close()



from fastapi.testclient import TestClient

from acceso.config import Settings
from acceso.web.app import create_app


@pytest.fixture
def settings(tmp_path):
    static = tmp_path / "static"
    for rel, text in (
        ("index.html", "<html>inicio</html>"),
        ("login/index.html", "<html>login</html>"),
        ("titulares/index.html", "<html>titulares</html>"),
        ("_next/static/x.js", "console.log(1)"),
    ):
        path = static / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return Settings(
        uart_port="",
        uart_baud=115200,
        admin_user="admin",
        admin_password="secreto",
        session_secret="s",
        web_host="127.0.0.1",
        web_port=8080,
        db_path=tmp_path / "web.sqlite",
        log_max_entries=100000,
        session_hours=12,
        cors_origins=(),
        static_dir=static,
    )


@pytest.fixture
def app(settings):
    return create_app(settings, login_fail_delay=0)


@pytest.fixture
def anon_client(app):
    return TestClient(app, follow_redirects=False)


@pytest.fixture
def client(app):
    c = TestClient(app, follow_redirects=False)
    r = c.post("/api/login", json={"username": "admin", "password": "secreto"})
    assert r.status_code == 204
    return c
