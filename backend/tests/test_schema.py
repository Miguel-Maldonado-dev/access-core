import sqlite3
import threading
import time

import pytest

from acceso.db import connect, transaction
from acceso.schema import create_schema
from helpers import NOW, add_card, add_control, add_holder


def _counts(conn):
    return [
        conn.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
        for t in ("outputs", "permissions", "holders")
    ]


def test_helpers_importable():
    assert NOW.weekday() == 1


def test_create_schema_defaults(conn):
    outputs = [tuple(r) for r in conn.execute("SELECT * FROM outputs ORDER BY output_id")]
    assert outputs == [(0, 3000, 3, 1), (1, 3000, 12, 1), (2, 3000, 0, 1), (3, 3000, 0, 1)]
    perms = [tuple(r) for r in conn.execute("SELECT * FROM permissions")]
    assert perms == [(0, "Acceso total", 15, 15, 127, 0, 0)]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 3
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_create_schema_is_idempotent(conn):
    before = _counts(conn)
    create_schema(conn)
    assert _counts(conn) == before


def test_checks_reject_bad_rows(conn):
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO outputs VALUES (4, 3000, 0, 1)")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO holders(kind, name) VALUES ('otro', 'x')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO holders(kind, name) VALUES ('persona', '  ')")


def test_deleting_holder_cascades_and_keeps_log_snapshot(conn):
    holder_id = add_holder(conn)
    add_card(conn, 123, holder_id)
    add_control(conn, holder_id, [(456, 0)])
    conn.execute(
        "INSERT INTO access_logs(timestamp, allowed, source, holder_id, holder_name, reason)"
        " VALUES (1, 1, 0, ?, 'Amadeo 1260', 0)",
        (holder_id,),
    )
    conn.execute("DELETE FROM holders WHERE holder_id = ?", (holder_id,))
    assert conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM controls").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM control_buttons").fetchone()[0] == 0
    row = conn.execute("SELECT holder_id, holder_name FROM access_logs").fetchone()
    assert row["holder_id"] is None
    assert row["holder_name"] == "Amadeo 1260"


def test_concurrent_write_waits_instead_of_failing(tmp_path):
    path = tmp_path / "c.sqlite"
    create_schema(connect(path))
    locked = threading.Event()
    errors = []

    def writer_a():
        try:
            a = connect(path)
            a.execute("BEGIN IMMEDIATE")
            a.execute("INSERT INTO holders(kind, name) VALUES ('persona', 'A')")
            locked.set()
            time.sleep(0.5)
            a.execute("COMMIT")
            a.close()
        except Exception as exc:  # pragma: no cover
            errors.append(exc)
            locked.set()

    t = threading.Thread(target=writer_a)
    t.start()
    assert locked.wait(5)
    b = connect(path)
    with transaction(b):
        b.execute("INSERT INTO holders(kind, name) VALUES ('persona', 'B')")
    t.join()
    assert not errors
    assert b.execute("SELECT COUNT(*) FROM holders").fetchone()[0] == 2
