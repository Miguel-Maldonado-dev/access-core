"""Bandeja de salida: lo que genera la capa store y la web local, y la guarda del agente."""
import threading
import time
import uuid

import pytest

from acceso.db import connect
from acceso.schema import create_schema
from acceso.store import cards, controls, holders, outputs, permissions
from acceso.store.controls import ButtonData
from acceso.store.holders import HolderData


def _entries(conn):
    return [dict(r) for r in conn.execute(
        "SELECT table_name, op, row_uuid FROM sync_outbox ORDER BY seq")]


def _clear(conn):
    conn.execute("DELETE FROM sync_outbox")


def _uuid_of(conn, table, where, params=()):
    return conn.execute("SELECT uuid FROM %s WHERE %s" % (table, where), params).fetchone()[0]


def _holder(client, **extra):
    body = {"kind": "persona", "name": "Ana"}
    body.update(extra)
    r = client.post("/api/holders", json=body)
    assert r.status_code == 201
    return r.json()["holder_id"]


def _card(client, code, holder_id):
    r = client.post("/api/cards", json={"card_code": code, "holder_id": holder_id, "description": ""})
    assert r.status_code == 201


# --- web local -> bandeja -------------------------------------------------------------------

def test_editing_a_card_enqueues_one_upsert_with_its_uuid(client, db):
    holder_id = _holder(client)
    _card(client, 111, holder_id)
    card_uuid = _uuid_of(db, "cards", "card_code=111")
    _clear(db)

    r = client.put("/api/cards/111", json={"holder_id": holder_id, "description": "Llavero"})

    assert r.status_code == 200
    assert _entries(db) == [{"table_name": "cards", "op": "upsert", "row_uuid": card_uuid}]


def test_deleting_a_card_enqueues_delete_with_the_old_uuid(client, db):
    holder_id = _holder(client)
    _card(client, 111, holder_id)
    card_uuid = _uuid_of(db, "cards", "card_code=111")
    _clear(db)

    assert client.delete("/api/cards/111").status_code == 204

    assert _entries(db) == [{"table_name": "cards", "op": "delete", "row_uuid": card_uuid}]


def test_deleting_a_holder_with_two_cards_enqueues_three_deletes(client, db):
    holder_id = _holder(client)
    _card(client, 111, holder_id)
    _card(client, 222, holder_id)
    expected = {
        _uuid_of(db, "holders", "holder_id=?", (holder_id,)),
        _uuid_of(db, "cards", "card_code=111"),
        _uuid_of(db, "cards", "card_code=222"),
    }
    _clear(db)

    assert client.delete("/api/holders/%d" % holder_id).status_code == 204

    entries = _entries(db)
    assert len(entries) == 3 and all(e["op"] == "delete" for e in entries)
    assert sorted(e["table_name"] for e in entries) == ["cards", "cards", "holders"]
    assert {e["row_uuid"] for e in entries} == expected


def test_saving_a_holder_without_permission_changes_enqueues_only_the_holder(client, db):
    holder_id = _holder(client, permission_ids=[0])
    holder_uuid = _uuid_of(db, "holders", "holder_id=?", (holder_id,))
    link_uuid = _uuid_of(db, "holder_permissions", "holder_id=?", (holder_id,))
    _clear(db)

    r = client.put("/api/holders/%d" % holder_id,
                   json={"kind": "persona", "name": "Ana María", "permission_ids": [0]})

    assert r.status_code == 200
    assert _entries(db) == [{"table_name": "holders", "op": "upsert", "row_uuid": holder_uuid}]
    assert _uuid_of(db, "holder_permissions", "holder_id=?", (holder_id,)) == link_uuid


def test_holder_permissions_change_by_difference(client, db):
    permissions.create_permission(db, {
        "permission_id": 1, "name": "B", "output_mask": 1, "card_reader_mask": 1,
        "pin_reader_mask": 0, "weekday_mask": 127, "start_minute": 0, "end_minute": 0,
        "allow_rf": True})
    holder_id = _holder(client, permission_ids=[0])
    keep_uuid = _uuid_of(db, "holder_permissions", "holder_id=? AND permission_id=0", (holder_id,))
    holder_uuid = _uuid_of(db, "holders", "holder_id=?", (holder_id,))
    _clear(db)

    body = {"kind": "persona", "name": "Ana", "permission_ids": [0, 1]}
    assert client.put("/api/holders/%d" % holder_id, json=body).status_code == 200
    added_uuid = _uuid_of(db, "holder_permissions", "holder_id=? AND permission_id=1", (holder_id,))
    assert sorted((e["table_name"], e["op"], e["row_uuid"]) for e in _entries(db)) == sorted([
        ("holders", "upsert", holder_uuid), ("holder_permissions", "upsert", added_uuid)])
    assert _uuid_of(db, "holder_permissions", "holder_id=? AND permission_id=0", (holder_id,)) == keep_uuid

    _clear(db)
    body["permission_ids"] = [1]
    assert client.put("/api/holders/%d" % holder_id, json=body).status_code == 200
    assert sorted((e["table_name"], e["op"], e["row_uuid"]) for e in _entries(db)) == sorted([
        ("holders", "upsert", holder_uuid), ("holder_permissions", "delete", keep_uuid)])
    assert _uuid_of(db, "holder_permissions", "holder_id=? AND permission_id=1", (holder_id,)) == added_uuid


def test_editing_a_control_keeps_unchanged_button_uuids(client, db):
    holder_id = _holder(client)
    body = {"holder_id": holder_id, "description": "C1", "buttons": [
        {"rf_code": 500, "output_id": 0}, {"rf_code": 501, "output_id": 1},
        {"rf_code": None, "output_id": None}, {"rf_code": None, "output_id": None}]}
    control_id = client.post("/api/controls", json=body).json()["control_id"]
    control_uuid = _uuid_of(db, "controls", "control_id=?", (control_id,))
    b0 = _uuid_of(db, "control_buttons", "button=0")
    b1 = _uuid_of(db, "control_buttons", "button=1")
    _clear(db)

    body["buttons"][1] = {"rf_code": 501, "output_id": 2}  # solo cambia la salida del botón 2
    assert client.put("/api/controls/%d" % control_id, json=body).status_code == 200

    assert sorted((e["table_name"], e["op"], e["row_uuid"]) for e in _entries(db)) == sorted([
        ("controls", "upsert", control_uuid), ("control_buttons", "upsert", b1)])
    assert _uuid_of(db, "control_buttons", "button=0") == b0
    assert _uuid_of(db, "control_buttons", "button=1") == b1
    assert db.execute("SELECT output_id FROM control_buttons WHERE button=1").fetchone()[0] == 2

    # quitar el botón 1 y cambiar el código del 0: borrado y alta del botón cambiado
    _clear(db)
    body["buttons"][1] = {"rf_code": None, "output_id": None}
    body["buttons"][0] = {"rf_code": 600, "output_id": 0}
    assert client.put("/api/controls/%d" % control_id, json=body).status_code == 200
    rows = [tuple(r) for r in db.execute(
        "SELECT button, rf_code FROM control_buttons ORDER BY button")]
    assert rows == [(0, 600)]
    ops = sorted((e["table_name"], e["op"]) for e in _entries(db))
    assert ops == [("control_buttons", "delete"), ("control_buttons", "delete"),
                   ("control_buttons", "upsert"), ("controls", "upsert")]


def test_swapping_button_codes_in_a_control_works(client, db):
    holder_id = _holder(client)
    body = {"holder_id": holder_id, "description": "", "buttons": [
        {"rf_code": 500, "output_id": 0}, {"rf_code": 501, "output_id": 1},
        {"rf_code": None, "output_id": None}, {"rf_code": None, "output_id": None}]}
    control_id = client.post("/api/controls", json=body).json()["control_id"]
    body["buttons"][0], body["buttons"][1] = body["buttons"][1], body["buttons"][0]

    assert client.put("/api/controls/%d" % control_id, json=body).status_code == 200

    assert [tuple(r) for r in db.execute(
        "SELECT button, rf_code, output_id FROM control_buttons ORDER BY button")] == [
        (0, 501, 1), (1, 500, 0)]


def test_editing_a_permission_and_an_output_enqueue_one_upsert_each(client, db):
    perm_uuid = _uuid_of(db, "permissions", "permission_id=0")
    out_uuid = _uuid_of(db, "outputs", "output_id=1")
    _clear(db)

    r = client.put("/api/permissions/0", json={
        "name": "Todo", "output_mask": 15, "card_reader_mask": 15, "pin_reader_mask": 0,
        "weekday_mask": 127, "start_minute": 0, "end_minute": 0, "allow_rf": True})
    assert r.status_code == 200
    r = client.put("/api/outputs/1", json={"duration_ms": 1000, "reader_mask": 3, "enabled": True})
    assert r.status_code == 200

    assert _entries(db) == [
        {"table_name": "permissions", "op": "upsert", "row_uuid": perm_uuid},
        {"table_name": "outputs", "op": "upsert", "row_uuid": out_uuid}]


# --- uuid, updated_at y origin en la capa store -----------------------------------------------

def _stamp(conn, table, where, params=()):
    return dict(conn.execute(
        "SELECT uuid, updated_at, origin FROM %s WHERE %s" % (table, where), params).fetchone())


def test_store_stamps_uuid_updated_at_and_origin_on_create_and_edit(db):
    t0 = int(time.time() * 1000)
    holder_id = holders.create_holder(db, HolderData(kind="persona", name="Ana", permission_ids=(0,)))
    cards.create_card(db, 111, holder_id, "")
    control_id = controls.create_control(
        db, holder_id, "", [ButtonData(500, 0), ButtonData(None, None),
                            ButtonData(None, None), ButtonData(None, None)])
    permissions.create_permission(db, {
        "permission_id": 1, "name": "B", "output_mask": 1, "card_reader_mask": 1,
        "pin_reader_mask": 0, "weekday_mask": 127, "start_minute": 0, "end_minute": 0,
        "allow_rf": False})

    targets = {
        "holders": ("holder_id=?", (holder_id,)),
        "holder_permissions": ("holder_id=?", (holder_id,)),
        "cards": ("card_code=111", ()),
        "controls": ("control_id=?", (control_id,)),
        "control_buttons": ("control_id=?", (control_id,)),
        "permissions": ("permission_id=1", ()),
    }
    created = {}
    for table, (where, params) in targets.items():
        stamp = _stamp(db, table, where, params)
        assert str(uuid.UUID(stamp["uuid"])) == stamp["uuid"], table
        assert stamp["updated_at"] >= t0 and stamp["origin"] == "local", table
        created[table] = stamp
    assert len({s["uuid"] for s in created.values()}) == len(created)

    time.sleep(0.01)
    db.execute("UPDATE holders SET origin='cloud'")
    db.execute("UPDATE cards SET origin='cloud'")
    db.execute("UPDATE controls SET origin='cloud'")
    db.execute("UPDATE permissions SET origin='cloud'")
    db.execute("UPDATE outputs SET origin='cloud'")
    holders.update_holder(db, holder_id, HolderData(kind="persona", name="Ana B", permission_ids=(0,)))
    cards.update_card(db, 111, holder_id, "Llavero")
    controls.update_control(db, control_id, holder_id, "C", [
        ButtonData(500, 1), ButtonData(None, None), ButtonData(None, None), ButtonData(None, None)])
    permissions.update_permission(db, 1, {
        "name": "B2", "output_mask": 1, "weekday_mask": 127, "start_minute": 0, "end_minute": 0})
    outputs.update_output(db, 2, 1000, 0, True)

    for table in ("holders", "cards", "controls", "permissions"):
        where, params = targets[table]
        stamp = _stamp(db, table, where, params)
        assert stamp["uuid"] == created[table]["uuid"], table
        assert stamp["updated_at"] > created[table]["updated_at"], table
        assert stamp["origin"] == "local", table
    assert _stamp(db, "outputs", "output_id=2")["origin"] == "local"
    assert _stamp(db, "control_buttons", "control_id=?", (control_id,))["uuid"] == \
        created["control_buttons"]["uuid"]


# --- guarda del agente (Riesgo 1) y escritura paralela (Riesgo 5) ----------------------------

def test_agent_changes_under_guard_do_not_enter_the_outbox(db):
    holder_id = holders.create_holder(db, HolderData(kind="persona", name="Ana"))
    _clear(db)

    db.execute("BEGIN IMMEDIATE")
    db.execute("UPDATE sync_guard SET applying=1")
    db.execute("INSERT INTO cards(card_code, holder_id, description, uuid, updated_at, origin)"
               " VALUES (111, ?, 'de la nube', ?, 1, 'cloud')", (holder_id, str(uuid.uuid4())))
    db.execute("UPDATE sync_guard SET applying=0")
    db.execute("COMMIT")
    assert _entries(db) == []

    cards.update_card(db, 111, holder_id, "local")
    assert [e["op"] for e in _entries(db)] == ["upsert"]


def test_web_write_during_agent_apply_waits_and_is_tracked(tmp_path):
    path = tmp_path / "c.sqlite"
    agent = connect(path)
    create_schema(agent)
    holder_id = holders.create_holder(agent, HolderData(kind="persona", name="Ana"))
    _clear(agent)

    applying = threading.Event()
    errors, finished = [], []

    def web():
        try:
            conn = connect(path)
            assert applying.wait(5)
            started = time.monotonic()
            cards.create_card(conn, 222, holder_id, "web")  # bloquea hasta que el agente confirme
            finished.append(time.monotonic() - started)
            conn.close()
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    thread = threading.Thread(target=web)
    thread.start()
    agent.execute("BEGIN IMMEDIATE")
    agent.execute("UPDATE sync_guard SET applying=1")
    agent.execute(
        "INSERT INTO cards(card_code, holder_id, description, uuid, updated_at)"
        " VALUES (111, ?, 'nube', ?, 1)", (holder_id, str(uuid.uuid4())))
    applying.set()
    time.sleep(0.5)
    agent.execute("UPDATE sync_guard SET applying=0")
    agent.execute("COMMIT")
    thread.join(10)

    assert not errors and finished and finished[0] >= 0.3  # esperó (busy_timeout), no falló
    codes = sorted(r[0] for r in agent.execute("SELECT card_code FROM cards"))
    assert codes == [111, 222]  # ninguna escritura se perdió
    web_uuid = _uuid_of(agent, "cards", "card_code=222")
    assert _entries(agent) == [{"table_name": "cards", "op": "upsert", "row_uuid": web_uuid}]
    agent.close()


# --- alias de salidas ---------------------------------------------------------------------

def test_outputs_list_includes_empty_alias(client, db):
    assert [o["alias"] for o in client.get("/api/outputs").json()] == [""] * 4


def test_output_alias_is_saved_and_listed(client, db):
    r = client.put("/api/outputs/0", json={
        "duration_ms": 3000, "reader_mask": 3, "enabled": True, "alias": "Pluma vehicular"})
    assert r.status_code == 200
    assert r.json() == {"output_id": 0, "duration_ms": 3000, "reader_mask": 3, "enabled": True,
                        "alias": "Pluma vehicular"}
    assert client.get("/api/outputs").json()[0]["alias"] == "Pluma vehicular"


def test_output_alias_is_trimmed_and_kept_when_omitted(client, db):
    client.put("/api/outputs/0", json={
        "duration_ms": 3000, "reader_mask": 3, "enabled": True, "alias": "  Portón  "})
    assert client.get("/api/outputs").json()[0]["alias"] == "Portón"
    # una pestaña vieja que no manda alias no lo borra
    r = client.put("/api/outputs/0", json={"duration_ms": 1000, "reader_mask": 3, "enabled": True})
    assert r.status_code == 200 and r.json()["alias"] == "Portón"
    # vacío sí lo borra
    r = client.put("/api/outputs/0", json={
        "duration_ms": 1000, "reader_mask": 3, "enabled": True, "alias": ""})
    assert r.json()["alias"] == ""


def test_output_alias_too_long_422(client, db):
    r = client.put("/api/outputs/0", json={
        "duration_ms": 1000, "reader_mask": 3, "enabled": True, "alias": "x" * 41})
    assert r.status_code == 422
    assert r.json()["detail"] == "El alias no puede pasar de 40 caracteres."
