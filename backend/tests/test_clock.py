from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient

from acceso.web.app import create_app
from acceso.web.clock import ClockStatus, read_clock


def fake_run(ntp="yes\n", tz="America/Mexico_City\n"):
    def run(cmd, **kwargs):
        out = ntp if "NTPSynchronized" in cmd else tz
        return SimpleNamespace(returncode=0, stdout=out)

    return run


def test_ntp_yes_and_no():
    assert read_clock(fake_run("yes\n")).ntp_synchronized is True
    assert read_clock(fake_run("no\n")).ntp_synchronized is False


def test_missing_timedatectl_gives_none():
    def run(cmd, **kwargs):
        raise FileNotFoundError()

    status = read_clock(run)
    assert status.ntp_synchronized is None
    assert status.timezone


def test_nonzero_exit_gives_none():
    def run(cmd, **kwargs):
        return SimpleNamespace(returncode=1, stdout="")

    assert read_clock(run).ntp_synchronized is None


def test_timezone_is_trimmed():
    assert read_clock(fake_run()).timezone == "America/Mexico_City"


def test_clock_endpoint(settings, client):
    fixed = ClockStatus(datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc), "UTC", True)
    c = TestClient(create_app(settings, login_fail_delay=0, clock_reader=lambda: fixed))
    c.post("/api/login", json={"username": "admin", "password": "secreto"})
    body = c.get("/api/system/clock").json()
    assert body == {"now": "2026-09-29T10:00:00+00:00", "timezone": "UTC", "ntp_synchronized": True}
