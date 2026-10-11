import time
from datetime import datetime

import pytest

from acceso.logs import HolderRef, append_log
from helpers import add_holder


@pytest.fixture(autouse=True)
def mexico_tz(monkeypatch):
    monkeypatch.setenv("TZ", "America/Mexico_City")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


def ts(*args):
    return int(datetime(*args).timestamp())


def log(db, timestamp, allowed=True, source=0, holder=None, reason=0):
    return append_log(db, timestamp=timestamp, allowed=allowed, source=source,
                      reason=reason, holder=holder, max_entries=100000)


def test_date_to_includes_whole_local_day(client, db):
    log(db, ts(2026, 10, 10, 23, 59, 30))
    log(db, ts(2026, 10, 11, 0, 0, 5))
    body = client.get("/api/logs?date_to=2026-10-10").json()
    assert body["total"] == 1
    assert body["items"][0]["timestamp"].startswith("2026-10-10T23:59:30")


def test_date_from_starts_at_local_midnight(client, db):
    log(db, ts(2026, 10, 9, 23, 59, 59))
    log(db, ts(2026, 10, 10, 0, 0, 0))
    assert client.get("/api/logs?date_from=2026-10-10").json()["total"] == 1


def test_timestamp_is_local_iso(client, db):
    log(db, ts(2026, 10, 10, 23, 59, 30))
    item = client.get("/api/logs").json()["items"][0]
    assert item["timestamp"] == "2026-10-10T23:59:30-06:00"
    assert item["allowed"] is True


def test_filters_combine(client, db):
    h = add_holder(db, "H")
    other = add_holder(db, "O")
    ref = HolderRef(h, "H", "domicilio")
    log(db, 1_790_000_000, allowed=False, source=1, holder=ref, reason=3)
    log(db, 1_790_000_001, allowed=True, source=1, holder=ref)
    log(db, 1_790_000_002, allowed=False, source=0, holder=ref)
    log(db, 1_790_000_003, allowed=False, source=1, holder=HolderRef(other, "O", "domicilio"))
    body = client.get("/api/logs?allowed=false&source=1&holder_id=%d" % h).json()
    assert body["total"] == 1
    item = body["items"][0]
    assert (item["holder_id"], item["holder_name"], item["allowed"], item["source"]) == (h, "H", False, 1)


def test_pagination_newest_first(client, db):
    for i in range(120):
        log(db, 1_790_000_000 + i)
    body = client.get("/api/logs?page=2&page_size=50").json()
    ids = [i["log_id"] for i in body["items"]]
    assert len(ids) == 50 and ids == sorted(ids, reverse=True)
    assert ids[0] == 70
    assert body["total"] == 120 and body["page"] == 2 and body["page_size"] == 50


def test_page_size_limit(client):
    r = client.get("/api/logs?page_size=500")
    assert r.status_code == 422
    assert isinstance(r.json()["detail"], str)


def test_malformed_date_is_422(client):
    r = client.get("/api/logs?date_from=ayer")
    assert r.status_code == 422
    assert isinstance(r.json()["detail"], str)


def test_clear_logs(client, db):
    log(db, 1_790_000_000)
    assert client.delete("/api/logs").status_code == 204
    assert client.get("/api/logs").json()["total"] == 0


def test_logs_require_session(anon_client):
    assert anon_client.get("/api/logs").status_code == 401
    assert anon_client.delete("/api/logs").status_code == 401
