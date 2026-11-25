"""Esquema v8: phones, call_settings y permissions.allow_call."""
import sqlite3
import uuid

import pytest

from acceso.constants import SCHEMA_VERSION


def _phone(conn, number="5512345678", holder=10, **kw):
    conn.execute("INSERT INTO phones(holder_id, number, uuid, updated_at) VALUES (?, ?, ?, 1)",
                 (holder, number, str(uuid.uuid4())))


@pytest.fixture
def holder(conn):
    conn.execute("INSERT INTO holders(holder_id, kind, name, uuid, updated_at)"
                 " VALUES (10, 'persona', 'Ana', ?, 1)", (str(uuid.uuid4()),))
    conn.execute("DELETE FROM sync_outbox")


def test_v8_tables(conn):
    assert SCHEMA_VERSION == 8
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 8
    row = conn.execute("SELECT enabled, mode, output_id, menu_mask, default_output,"
                       " call_limit_per_minute FROM call_settings WHERE id=1").fetchone()
    assert tuple(row) == (0, "single", 0, 0, None, 3)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(permissions)")]
    assert cols[-1] == "allow_call"
    assert conn.execute("SELECT allow_call FROM permissions").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0] == 27


def test_phone_insert_fires_outbox(conn, holder):
    _phone(conn)
    assert [tuple(r) for r in conn.execute("SELECT table_name, op FROM sync_outbox")] == [
        ("phones", "upsert")]


def test_call_settings_update_fires_outbox(conn):
    conn.execute("UPDATE call_settings SET enabled=1, updated_at=5")
    assert [tuple(r) for r in conn.execute("SELECT table_name, op FROM sync_outbox")] == [
        ("call_settings", "upsert")]


def test_phone_number_unique(conn, holder):
    _phone(conn)
    with pytest.raises(sqlite3.IntegrityError):
        _phone(conn)


@pytest.mark.parametrize("number", ["551234567", "55123456789", "55123456a8", "55 1234567"])
def test_phone_number_check(conn, holder, number):
    with pytest.raises(sqlite3.IntegrityError):
        _phone(conn, number)


def test_phone_cascade_on_holder_delete(conn, holder):
    _phone(conn)
    conn.execute("DELETE FROM holders WHERE holder_id=10")
    assert conn.execute("SELECT COUNT(*) FROM phones").fetchone()[0] == 0
    assert ("phones", "delete") in [tuple(r) for r in conn.execute(
        "SELECT table_name, op FROM sync_outbox")]


@pytest.mark.parametrize("sets", ["mode='otro'", "enabled=2", "output_id=4", "menu_mask=16",
                                  "default_output=4", "call_limit_per_minute=0",
                                  "call_limit_per_minute=21", "allow_call=1"])
def test_call_settings_checks(conn, sets):
    if sets == "allow_call=1":
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("UPDATE call_settings SET " + sets)
        return
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE call_settings SET " + sets)


def test_call_settings_single_row_and_allow_call_check(conn):
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO call_settings(id, uuid, updated_at) VALUES (2, 'x', 1)")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE permissions SET allow_call=2")
    conn.execute("UPDATE call_settings SET default_output=NULL, output_id=3, menu_mask=15")
