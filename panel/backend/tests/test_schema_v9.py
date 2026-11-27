"""Esquema v9: qr_codes, qr_uses, qr_settings y permissions.qr_reader_mask."""
import sqlite3
import uuid

import pytest

from acceso.constants import REPLICATED_TABLES, SCHEMA_VERSION


def _qr(conn, code=900000001, valid_from=1000, valid_until=2000, holder=10):
    conn.execute("INSERT INTO qr_codes(holder_id, code, valid_from, valid_until, created_at, uuid, updated_at)"
                 " VALUES (?, ?, ?, ?, 1, ?, 1)", (holder, code, valid_from, valid_until, str(uuid.uuid4())))
    return conn.execute("SELECT qr_id FROM qr_codes WHERE code=?", (code,)).fetchone()[0]


@pytest.fixture
def holder(conn):
    conn.execute("INSERT INTO holders(holder_id, kind, name, uuid, updated_at)"
                 " VALUES (10, 'persona', 'Ana', ?, 1)", (str(uuid.uuid4()),))
    conn.execute("DELETE FROM sync_outbox")


def test_v9_tables(conn):
    assert SCHEMA_VERSION == 9
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
    assert REPLICATED_TABLES[-1] == "qr_codes"
    assert tuple(conn.execute("SELECT digit, max_active FROM qr_settings WHERE id=1").fetchone()) == (9, 1000)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(permissions)")]
    assert cols[-1] == "qr_reader_mask"
    assert conn.execute("SELECT qr_reader_mask FROM permissions").fetchone()[0] == 0


def test_qr_insert_fires_outbox(conn, holder):
    _qr(conn)
    rows = [tuple(r) for r in conn.execute("SELECT table_name, op FROM sync_outbox")]
    assert rows == [("qr_codes", "upsert")]


def test_qr_uses_not_in_outbox(conn, holder):
    qr_id = _qr(conn)
    conn.execute("DELETE FROM sync_outbox")
    conn.execute("INSERT INTO qr_uses(qr_id, reader, count) VALUES (?, 0, 1)", (qr_id,))
    conn.execute("UPDATE qr_uses SET count=2")
    assert conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0] == 0


def test_qr_settings_not_in_outbox(conn):
    conn.execute("UPDATE qr_settings SET digit=5, max_active=10, updated_at=5")
    assert conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0] == 0


def test_qr_cascade_on_holder_delete(conn, holder):
    qr_id = _qr(conn)
    conn.execute("INSERT INTO qr_uses(qr_id, reader, count) VALUES (?, 1, 1)", (qr_id,))
    conn.execute("DELETE FROM holders WHERE holder_id=10")
    assert conn.execute("SELECT COUNT(*) FROM qr_codes").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM qr_uses").fetchone()[0] == 0


@pytest.mark.parametrize("valid_from,valid_until", [(2000, 2000), (2000, 1000)])
def test_qr_validity_check(conn, holder, valid_from, valid_until):
    with pytest.raises(sqlite3.IntegrityError):
        _qr(conn, valid_from=valid_from, valid_until=valid_until)


def test_qr_checks(conn, holder):
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE qr_settings SET digit=0")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE permissions SET qr_reader_mask=16")
    qr_id = _qr(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE qr_codes SET max_uses=101 WHERE qr_id=?", (qr_id,))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO qr_uses(qr_id, reader) VALUES (?, 4)", (qr_id,))
    with pytest.raises(sqlite3.IntegrityError):
        _qr(conn)  # código repetido
