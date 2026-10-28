"""Esquema v6: columnas de sincronización, bandeja de salida y triggers."""
import re
import sqlite3
import uuid

import pytest

from acceso.constants import SCHEMA_VERSION
from acceso.db import connect

REPLICATED = ("holders", "cards", "controls", "control_buttons", "permissions",
              "holder_permissions", "outputs")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _cols(conn, table):
    return {r["name"]: r for r in conn.execute("PRAGMA table_info(%s)" % table)}


def _outbox(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM sync_outbox ORDER BY seq")]


def _ins(conn, table, **values):
    """Alta cruda con uuid y updated_at, como la haría la capa store."""
    values.setdefault("uuid", str(uuid.uuid4()))
    values.setdefault("updated_at", 1_000)
    conn.execute("INSERT INTO %s(%s) VALUES (%s)" % (
        table, ", ".join(values), ", ".join("?" * len(values))), tuple(values.values()))
    return values["uuid"]


def _scenario(conn):
    """Un registro en cada tabla replicada (sin tocar las salidas, que ya existen)."""
    _ins(conn, "holders", holder_id=10, kind="persona", name="Ana")
    _ins(conn, "cards", card_code=111, holder_id=10)
    _ins(conn, "controls", control_id=5, holder_id=10)
    _ins(conn, "control_buttons", control_id=5, button=0, rf_code=500, output_id=0)
    _ins(conn, "holder_permissions", holder_id=10, permission_id=0)


def test_schema_version_is_6(conn):
    assert SCHEMA_VERSION == 6
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 6


@pytest.mark.parametrize("table", REPLICATED)
def test_replicated_tables_have_sync_columns(conn, table):
    cols = _cols(conn, table)
    assert cols["uuid"]["type"] == "TEXT" and cols["uuid"]["notnull"] == 1
    assert cols["updated_at"]["type"] == "INTEGER" and cols["updated_at"]["notnull"] == 1
    assert cols["origin"]["type"] == "TEXT" and cols["origin"]["notnull"] == 1
    assert cols["origin"]["dflt_value"] == "'local'"
    unique = [r for r in conn.execute("PRAGMA index_list(%s)" % table) if r["unique"]]
    uuid_unique = [r for r in unique
                   if [c["name"] for c in conn.execute("PRAGMA index_info(%s)" % r["name"])] == ["uuid"]]
    assert uuid_unique, "uuid debe ser UNIQUE"


def test_outputs_have_alias_with_empty_default(conn):
    alias = _cols(conn, "outputs")["alias"]
    assert alias["type"] == "TEXT" and alias["notnull"] == 1 and alias["dflt_value"] == "''"
    assert [r["alias"] for r in conn.execute("SELECT alias FROM outputs")] == [""] * 4


def test_uuid_must_be_unique_and_present(conn):
    shared = _ins(conn, "holders", kind="persona", name="A")
    with pytest.raises(sqlite3.IntegrityError):
        _ins(conn, "holders", kind="persona", name="B", uuid=shared)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO holders(kind, name, updated_at) VALUES ('persona', 'C', 1)")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO holders(kind, name, uuid) VALUES ('persona', 'C', 'u')")


def test_sync_tables_shape(conn):
    outbox = _cols(conn, "sync_outbox")
    assert list(outbox) == ["seq", "change_id", "table_name", "op", "row_uuid", "updated_at"]
    assert outbox["seq"]["pk"] == 1
    assert all(outbox[c]["notnull"] == 1 for c in list(outbox)[1:])
    sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='sync_outbox'").fetchone()[0]
    assert "AUTOINCREMENT" in sql
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                     " VALUES ('a', 'cards', 'otra', 'u', 1)")
    conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                 " VALUES ('a', 'cards', 'upsert', 'u', 1)")
    with pytest.raises(sqlite3.IntegrityError):  # change_id único
        conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                     " VALUES ('a', 'cards', 'delete', 'u', 1)")

    state = _cols(conn, "sync_state")
    assert list(state) == ["key", "value"] and state["key"]["pk"] == 1 and state["value"]["notnull"] == 1


def test_sync_guard_has_single_row_off(conn):
    assert [tuple(r) for r in conn.execute("SELECT id, applying FROM sync_guard")] == [(1, 0)]
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO sync_guard(id, applying) VALUES (2, 0)")


def test_triggers_exist_for_every_replicated_table(conn):
    triggers = {r["name"]: r["tbl_name"] for r in conn.execute(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'")}
    assert len(triggers) == 21
    for table in REPLICATED:
        assert sorted(n for n, t in triggers.items() if t == table) == sorted(
            "%s_sync_%s" % (table, suffix) for suffix in ("ins", "upd", "del"))


def test_fresh_database_starts_with_empty_outbox_and_uuids_on_defaults(conn):
    assert _outbox(conn) == []
    for table in ("outputs", "permissions"):
        uuids = [r[0] for r in conn.execute("SELECT uuid FROM %s" % table)]
        assert uuids and all(UUID_RE.match(u) for u in uuids) and len(set(uuids)) == len(uuids)
    assert all(r["updated_at"] > 1_700_000_000_000 and r["origin"] == "local"
               for r in conn.execute("SELECT updated_at, origin FROM outputs"))


def test_triggers_enqueue_upsert_and_delete_with_exact_payload(conn):
    holder_uuid = _ins(conn, "holders", kind="persona", name="Ana", updated_at=1234)
    assert [(e["table_name"], e["op"], e["row_uuid"], e["updated_at"]) for e in _outbox(conn)] == [
        ("holders", "upsert", holder_uuid, 1234)]
    assert re.fullmatch(r"[0-9a-f]{32}", _outbox(conn)[0]["change_id"])

    conn.execute("UPDATE holders SET name='Ana B', updated_at=2345 WHERE uuid=?", (holder_uuid,))
    last = _outbox(conn)[-1]
    assert (last["op"], last["row_uuid"], last["updated_at"]) == ("upsert", holder_uuid, 2345)

    before = conn.execute("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)").fetchone()[0]
    conn.execute("DELETE FROM holders WHERE uuid=?", (holder_uuid,))
    after = conn.execute("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)").fetchone()[0]
    last = _outbox(conn)[-1]
    assert (last["op"], last["row_uuid"]) == ("delete", holder_uuid)
    assert before <= last["updated_at"] <= after  # hora de borrado, no la del registro

    ids = [e["change_id"] for e in _outbox(conn)]
    assert len(set(ids)) == 3


def test_every_replicated_table_is_covered_including_cascades(conn):
    _scenario(conn)
    conn.execute("UPDATE outputs SET duration_ms=1000 WHERE output_id=1")
    conn.execute("UPDATE permissions SET name='x' WHERE permission_id=0")
    seen = {(e["table_name"], e["op"]) for e in _outbox(conn)}
    assert seen == {(t, "upsert") for t in REPLICATED}

    conn.execute("DELETE FROM sync_outbox")
    conn.execute("DELETE FROM holders WHERE holder_id=10")  # cascada: tarjeta, control, botón, asignación
    deleted = sorted(e["table_name"] for e in _outbox(conn) if e["op"] == "delete")
    assert deleted == ["cards", "control_buttons", "controls", "holder_permissions", "holders"]
    assert all(e["op"] == "delete" for e in _outbox(conn))


def test_guard_suppresses_every_trigger(conn):
    _scenario(conn)
    conn.execute("DELETE FROM sync_outbox")
    conn.execute("UPDATE sync_guard SET applying=1")
    _ins(conn, "cards", card_code=222, holder_id=10)
    conn.execute("UPDATE cards SET description='x' WHERE card_code=111")
    conn.execute("UPDATE outputs SET duration_ms=900 WHERE output_id=0")
    conn.execute("DELETE FROM holders WHERE holder_id=10")
    assert _outbox(conn) == []


def test_guard_inside_transaction_rolls_back_to_off(conn):
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE sync_guard SET applying=1")
    _ins(conn, "holders", kind="persona", name="de la nube")
    conn.execute("ROLLBACK")
    assert conn.execute("SELECT applying FROM sync_guard").fetchone()[0] == 0
    _ins(conn, "holders", kind="persona", name="local")
    assert len(_outbox(conn)) == 1


def test_guard_applied_and_reset_in_one_transaction_leaves_next_change_tracked(conn):
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE sync_guard SET applying=1")
    _ins(conn, "holders", kind="persona", name="de la nube")
    assert _outbox(conn) == []
    conn.execute("UPDATE sync_guard SET applying=0")
    conn.execute("COMMIT")
    assert _outbox(conn) == []
    _ins(conn, "holders", kind="persona", name="local")
    assert [e["op"] for e in _outbox(conn)] == ["upsert"]


def test_create_schema_is_idempotent_for_sync_objects(conn):
    from acceso.schema import create_schema
    create_schema(conn)
    assert conn.execute("SELECT COUNT(*) FROM sync_guard").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0] == 21
    assert _outbox(conn) == []


def test_connection_waits_for_locks(tmp_path):
    conn = connect(tmp_path / "t.sqlite")
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
