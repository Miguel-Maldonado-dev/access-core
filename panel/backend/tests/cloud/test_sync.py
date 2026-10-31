"""Motor de sincronización del agente acceso-cloud contra una nube falsa que sigue el contrato real."""
import json
import logging
import os
import re
import sqlite3
import stat
import uuid
from datetime import datetime

import httpx
import pytest
from fake_cloud import FakeCloud

from acceso.access import handle_event
from acceso.cloud import sync
from acceso.cloud.api import CloudError
from acceso.cloud.identity import get_state, set_state
from acceso.cloud.mapping import InvalidChange, apply_batch, snapshot_tables
from acceso.cloud.sync import SyncBlocked, SyncEngine
from acceso.constants import REASON_ALLOWED, REASON_NO_PERMISSION
from acceso.protocol import CardRead
from acceso.store import cards, controls, holders
from acceso.store.controls import ButtonData
from acceso.store.holders import HolderData

NOW = 1_800_000_000.0
MONDAY_NOON = datetime(2026, 10, 26, 12, 0)


@pytest.fixture
def db_path(tmp_path, conn):
    return tmp_path / "test.sqlite"


@pytest.fixture
def cloud():
    return FakeCloud()


def engine_for(db_path, cloud):
    return SyncEngine(db_path, cloud.api(), now=lambda: NOW)


def outbox(conn):
    return [dict(r) for r in conn.execute(
        "SELECT seq, change_id, table_name, op, row_uuid FROM sync_outbox ORDER BY seq")]


def uuid_of(conn, table, where, params=()):
    return conn.execute("SELECT uuid FROM %s WHERE %s" % (table, where), params).fetchone()[0]


def new_holder(conn, name="Ana", pin=None, permission_ids=(0,)):
    return holders.create_holder(conn, HolderData(kind="persona", name=name, pin=pin,
                                                  permission_ids=permission_ids))


def holder_data(name="Ana", pin=None):
    return {"kind": "persona", "name": name, "department": "", "address": "", "notes": "", "pin": pin}


def mark_synced(conn, cloud):
    """La nube tiene lo mismo que el panel, la bandeja está vacía y el cursor al día."""
    cloud.seed(snapshot_tables(conn))
    conn.execute("DELETE FROM sync_outbox")
    set_state(conn, "cloud_revision", str(cloud.revision))


def cursor(conn):
    return int(get_state(conn, "cloud_revision", "0"))


def card_codes(conn):
    return [r[0] for r in conn.execute("SELECT card_code FROM cards ORDER BY card_code")]


def edit_under_guard(conn, sql, params=()):
    """Escribe como lo haría el agente (sin pasar por la bandeja)."""
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE sync_guard SET applying=1 WHERE id=1")
    conn.execute(sql, params)
    conn.execute("UPDATE sync_guard SET applying=0 WHERE id=1")
    conn.execute("COMMIT")


# --- push -------------------------------------------------------------------------------------

def test_push_sends_a_card_created_in_the_local_web_and_empties_the_outbox(client, db, settings, cloud):
    r = client.post("/api/holders", json={"kind": "persona", "name": "Ana", "permission_ids": [0]})
    holder_id = r.json()["holder_id"]
    assert client.post("/api/cards", json={"card_code": 111, "holder_id": holder_id,
                                           "description": "Llavero"}).status_code == 201
    holder_uuid = uuid_of(db, "holders", "holder_id=?", (holder_id,))
    card_uuid = uuid_of(db, "cards", "card_code=111")
    pending = {e["row_uuid"]: e["change_id"] for e in outbox(db)}

    sent = engine_for(settings.db_path, cloud).push()

    assert sent == 3  # titular, su permiso y la tarjeta
    items = cloud.pushed[0]
    assert [i["table"] for i in items] == ["holders", "holder_permissions", "cards"]
    card = items[2]
    assert card["change_id"] == pending[card_uuid] and re.match(r"^[0-9a-f]{32}$", card["change_id"])
    assert card["op"] == "upsert" and card["id"] == card_uuid
    assert card["data"] == {"card_code": 111, "holder_id": holder_uuid, "description": "Llavero"}
    assert outbox(db) == []
    assert cloud.live_row("cards", card_uuid)["card_code"] == 111


def test_three_local_edits_of_the_same_card_are_sent_as_one_change(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "")
    mark_synced(conn, cloud)
    for text in ("uno", "dos", "tres"):
        cards.update_card(conn, 5, holder_id, text)
    assert len(outbox(conn)) == 3

    assert engine_for(db_path, cloud).push() == 1

    assert len(cloud.pushed) == 1 and len(cloud.pushed[0]) == 1
    assert cloud.pushed[0][0]["data"]["description"] == "tres"
    assert outbox(conn) == []


def test_push_omits_an_upsert_whose_row_no_longer_exists(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "")
    mark_synced(conn, cloud)
    cards.update_card(conn, 5, holder_id, "x")
    edit_under_guard(conn, "DELETE FROM cards WHERE card_code=5")

    assert engine_for(db_path, cloud).push() == 0

    assert cloud.pushed == [] and outbox(conn) == []


def test_rejected_with_current_null_deletes_the_local_row_without_entering_the_outbox(conn, db_path, cloud):
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    cards.create_card(conn, 5, holder_id, "")
    card_uuid = uuid_of(conn, "cards", "card_code=5")
    cloud.forced[card_uuid] = ("rejected", "duplicado")

    engine_for(db_path, cloud).push()

    assert card_codes(conn) == []
    assert outbox(conn) == []
    assert "duplicado" in get_state(conn, "last_error")


def test_rejected_as_merged_deletes_the_local_copy_without_reporting_an_error(conn, db_path, cloud, caplog):
    # La nube fusionó el botón nuevo con uno vivo del mismo titular: el panel borra su copia
    # (current null) y lo recibe en el siguiente pull. No es un error para la página "Nube".
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    controls.create_control(conn, holder_id, "Control", BUTTONS)
    button_uuid = uuid_of(conn, "control_buttons", "rf_code=555")
    cloud.forced[button_uuid] = ("rejected", "fusionado")

    with caplog.at_level(logging.INFO, logger="acceso.cloud"):
        engine_for(db_path, cloud).push()

    assert conn.execute("SELECT count(*) FROM control_buttons WHERE uuid=?", (button_uuid,)).fetchone()[0] == 0
    assert outbox(conn) == []
    assert get_state(conn, "last_error") in (None, "")
    assert "fusionó" in caplog.text


def test_superseded_with_current_keeps_the_cloud_version(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "original")
    mark_synced(conn, cloud)
    card_uuid = uuid_of(conn, "cards", "card_code=5")
    cloud_data = dict(cloud.live_row("cards", card_uuid), description="Nube")
    cloud.put("cards", card_uuid, cloud_data)
    cards.update_card(conn, 5, holder_id, "Local")
    cloud.forced[card_uuid] = ("superseded", None)

    engine_for(db_path, cloud).push()

    assert cards.get_card(conn, 5)["description"] == "Nube"
    assert outbox(conn) == []


def test_rejected_because_related_is_missing_keeps_the_row_and_requeues_with_a_new_change_id(conn, db_path, cloud):
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    cards.create_card(conn, 5, holder_id, "")
    card_uuid = uuid_of(conn, "cards", "card_code=5")
    [entry] = outbox(conn)
    cloud.forced[card_uuid] = ("rejected", "relacionado no existe")

    assert engine_for(db_path, cloud).push() == 1

    assert card_codes(conn) == [5]
    [again] = outbox(conn)
    assert (again["table_name"], again["op"], again["row_uuid"]) == ("cards", "upsert", card_uuid)
    assert again["change_id"] != entry["change_id"]


# --- pull -------------------------------------------------------------------------------------

def test_pull_inserts_a_new_card_without_entering_the_outbox(conn, db_path, cloud):
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    card_uuid = str(uuid.uuid4())
    cloud.put("cards", card_uuid, {"card_code": 777, "holder_id": holder_uuid, "description": "Nube"})

    assert engine_for(db_path, cloud).pull() == 1

    card = cards.get_card(conn, 777)
    assert card["holder_id"] == holder_id and card["description"] == "Nube"
    assert uuid_of(conn, "cards", "card_code=777") == card_uuid
    assert outbox(conn) == []  # Riesgo 1: lo que llega de la nube no rebota
    assert cursor(conn) == cloud.revision
    assert get_state(conn, "last_sync_at") == "2027-01-15T08:00:00.000Z"
    assert conn.execute("SELECT applying FROM sync_guard").fetchone()[0] == 0


def test_pull_failing_on_page_two_applies_nothing_and_the_retry_applies_everything(
        conn, db_path, cloud, monkeypatch):
    monkeypatch.setattr(sync, "CHANGES_PAGE", 2)
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    start = cursor(conn)
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    for code in (1, 2, 3):
        cloud.put("cards", str(uuid.uuid4()), {"card_code": code, "holder_id": holder_uuid, "description": ""})

    def fail_after_first_page(request):
        if request.url.path.endswith("/changes") and request.url.params["since"] != str(start):
            return httpx.Response(503, json={"code": "unavailable", "message": "Caída"})
        return None

    cloud.fail = fail_after_first_page
    engine = engine_for(db_path, cloud)
    with pytest.raises(CloudError):
        engine.pull()

    assert len(cloud.paths("GET")) == 2
    assert card_codes(conn) == []
    assert cursor(conn) == start

    cloud.fail = None
    assert engine.pull() == 3
    assert card_codes(conn) == [1, 2, 3]
    assert cursor(conn) == cloud.revision
    assert [p["since"] for m, path, p, _ in cloud.requests if m == "GET"][2] == str(start)


def test_pull_applies_a_card_that_arrives_before_its_holder(conn, db_path, cloud):
    mark_synced(conn, cloud)
    holder_uuid, card_uuid = str(uuid.uuid4()), str(uuid.uuid4())
    cloud.revision = 9
    assert cloud.put("cards", card_uuid, {"card_code": 42, "holder_id": holder_uuid, "description": ""}) == 10
    cloud.revision = 11
    assert cloud.put("holders", holder_uuid, holder_data("Beto")) == 12

    engine_for(db_path, cloud).pull()

    holder_id = conn.execute("SELECT holder_id FROM holders WHERE uuid=?", (holder_uuid,)).fetchone()[0]
    assert cards.get_card(conn, 42)["holder_id"] == holder_id
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert cursor(conn) == 12


def test_pull_deleting_card_x_and_creating_card_y_with_the_same_code_keeps_y(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "X")
    mark_synced(conn, cloud)
    x_uuid = uuid_of(conn, "cards", "card_code=5")
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    y_uuid = str(uuid.uuid4())
    cloud.put("cards", y_uuid, {"card_code": 5, "holder_id": holder_uuid, "description": "Y"})
    cloud.remove("cards", x_uuid)  # el borrado llega después del alta en el lote

    engine_for(db_path, cloud).pull()

    assert uuid_of(conn, "cards", "card_code=5") == y_uuid
    assert cards.get_card(conn, 5)["description"] == "Y"
    assert outbox(conn) == []


def test_pull_where_y_takes_code_5_before_x_moves_to_code_6_keeps_both(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "X")
    mark_synced(conn, cloud)
    x_uuid = uuid_of(conn, "cards", "card_code=5")
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    y_uuid = str(uuid.uuid4())
    cloud.put("cards", y_uuid, {"card_code": 5, "holder_id": holder_uuid, "description": "Y"})
    cloud.put("cards", x_uuid, {"card_code": 6, "holder_id": holder_uuid, "description": "X"})
    # X llega después que Y en el lote: la tarjeta 5 se libera antes de dar de alta Y.
    cloud.rows["cards"][x_uuid]["revision"], cloud.rows["cards"][y_uuid]["revision"] = (
        cloud.revision, cloud.revision - 1)

    engine_for(db_path, cloud).pull()

    assert uuid_of(conn, "cards", "card_code=5") == y_uuid
    assert uuid_of(conn, "cards", "card_code=6") == x_uuid


def test_pull_moving_a_profile_to_another_permission_id_keeps_its_assignments(conn, db_path, cloud):
    conn.execute("INSERT INTO permissions(permission_id, name, output_mask, card_reader_mask, pin_reader_mask,"
                 " weekday_mask, start_minute, end_minute, allow_rf, uuid, updated_at)"
                 " VALUES (3, 'Peatonal', 1, 1, 0, 127, 0, 0, 0, ?, 1)", (str(uuid.uuid4()),))
    holder_id = new_holder(conn, permission_ids=(3,))
    mark_synced(conn, cloud)
    perm_uuid = uuid_of(conn, "permissions", "permission_id=3")
    assignment = uuid_of(conn, "holder_permissions", "holder_id=?", (holder_id,))
    # Solo cambia el perfil: la nube no vuelve a emitir sus asignaciones.
    cloud.put("permissions", perm_uuid, dict(cloud.live_row("permissions", perm_uuid), permission_id=5))

    engine_for(db_path, cloud).pull()

    assert uuid_of(conn, "permissions", "permission_id=5") == perm_uuid
    assert [tuple(r) for r in conn.execute("SELECT permission_id, uuid FROM holder_permissions"
                                           " WHERE holder_id=?", (holder_id,))] == [(5, assignment)]
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_pull_does_not_overwrite_a_row_with_a_pending_local_change(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "original")
    mark_synced(conn, cloud)
    card_uuid = uuid_of(conn, "cards", "card_code=5")
    cloud.put("cards", card_uuid, dict(cloud.live_row("cards", card_uuid), description="Nube"))
    cards.update_card(conn, 5, holder_id, "Local")

    engine_for(db_path, cloud).pull()

    assert cards.get_card(conn, 5)["description"] == "Local"  # la nube decide al subirlo
    assert [e["row_uuid"] for e in outbox(conn)] == [card_uuid]
    assert cursor(conn) == cloud.revision


def test_pull_moves_a_pin_taken_by_another_holder_without_deleting_that_holder(conn, db_path, cloud):
    mark_synced(conn, cloud)
    local_id = new_holder(conn, "Local", pin="1234")
    cards.create_card(conn, 9, local_id, "")
    other = str(uuid.uuid4())
    cloud.put("holders", other, holder_data("Nube", pin="1234"))

    engine_for(db_path, cloud).pull()

    assert conn.execute("SELECT name FROM holders WHERE pin='1234'").fetchone()[0] == "Nube"
    assert conn.execute("SELECT pin FROM holders WHERE holder_id=?", (local_id,)).fetchone()[0] is None
    assert card_codes(conn) == [9]


def _cards_synced(conn, cloud, count):
    holder_id = new_holder(conn)
    for code in range(1, count + 1):
        cards.create_card(conn, code, holder_id, "")
    mark_synced(conn, cloud)
    return [r[0] for r in conn.execute("SELECT uuid FROM cards ORDER BY card_code")]


def test_pull_that_would_delete_30_of_100_cards_is_blocked_until_deletions_are_confirmed(conn, db_path, cloud):
    card_uuids = _cards_synced(conn, cloud, 100)
    start = cursor(conn)
    for card_uuid in card_uuids[:30]:
        cloud.remove("cards", card_uuid)
    engine = engine_for(db_path, cloud)

    with pytest.raises(SyncBlocked) as blocked:
        engine.pull()

    assert (blocked.value.table, blocked.value.would_delete, blocked.value.total) == ("cards", 30, 100)
    assert cloud.alerts == [{"type": "mass_delete_blocked", "table": "cards", "would_delete": 30, "total": 100}]
    assert len(card_codes(conn)) == 100
    assert cursor(conn) == start

    cloud.confirm_deletions = True
    assert engine.pull() == 30
    assert len(card_codes(conn)) == 70
    assert cursor(conn) == cloud.revision


def test_deleting_3_of_5_cards_is_never_blocked(conn, db_path, cloud):
    card_uuids = _cards_synced(conn, cloud, 5)
    for card_uuid in card_uuids[:3]:
        cloud.remove("cards", card_uuid)

    engine_for(db_path, cloud).pull()

    assert card_codes(conn) == [4, 5]
    assert cloud.alerts == []


def test_a_permission_with_zero_masks_is_applied_and_the_daemon_denies_the_card(conn, db_path, cloud):
    holder_id = new_holder(conn, permission_ids=(0,))
    cards.create_card(conn, 5, holder_id, "")
    mark_synced(conn, cloud)

    def read_card():
        return handle_event(conn, CardRead(0, 5), lambda frame: None, now=MONDAY_NOON, max_entries=100)

    assert read_card().reason == REASON_ALLOWED
    permission_uuid = uuid_of(conn, "permissions", "permission_id=0")
    zero = {"permission_id": 0, "name": "Acceso total", "output_mask": 0, "card_reader_mask": 0,
            "pin_reader_mask": 0, "allow_rf": False, "weekday_mask": 0, "start_minute": 0, "end_minute": 0}
    cloud.put("permissions", permission_uuid, zero)

    engine_for(db_path, cloud).pull()

    row = conn.execute("SELECT output_mask, card_reader_mask, allow_rf FROM permissions"
                       " WHERE permission_id=0").fetchone()
    assert tuple(row) == (0, 0, 0)
    outcome = read_card()
    assert not outcome.allowed and outcome.reason == REASON_NO_PERMISSION


def test_pull_with_a_cloud_revision_behind_the_cursor_reconciles(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "")
    mark_synced(conn, cloud)
    set_state(conn, "cloud_revision", str(cloud.revision + 50))
    edit_under_guard(conn, "UPDATE cards SET description='desfasada' WHERE card_code=5")

    engine_for(db_path, cloud).pull()

    assert "/checksums" in cloud.paths("GET")
    assert cards.get_card(conn, 5)["description"] == ""
    assert cursor(conn) == cloud.revision


# --- reconcile --------------------------------------------------------------------------------

def test_reconcile_replaces_only_the_table_whose_checksum_differs(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "bien")
    cards.create_card(conn, 6, holder_id, "")
    mark_synced(conn, cloud)
    holders_before = [tuple(r) for r in conn.execute("SELECT * FROM holders")]
    edit_under_guard(conn, "UPDATE cards SET description='mal' WHERE card_code=5")
    edit_under_guard(conn, "DELETE FROM cards WHERE card_code=6")
    edit_under_guard(conn, "INSERT INTO cards(card_code, holder_id, description, uuid, updated_at)"
                           " VALUES (8, ?, '', ?, 1)", (holder_id, str(uuid.uuid4())))

    assert engine_for(db_path, cloud).reconcile() == ["cards"]

    assert card_codes(conn) == [5, 6]
    assert cards.get_card(conn, 5)["description"] == "bien"
    snapshots = [p["table"] for m, path, p, _ in cloud.requests if path == "/snapshot"]
    assert snapshots == ["cards"]
    assert [tuple(r) for r in conn.execute("SELECT * FROM holders")] == holders_before
    assert outbox(conn) == []
    assert cursor(conn) == cloud.revision


def test_reconcile_has_the_same_mass_delete_protection_and_alerts_outside_the_transaction(
        conn, db_path, cloud):
    card_uuids = _cards_synced(conn, cloud, 100)
    for card_uuid in card_uuids[:30]:
        del cloud.rows["cards"][card_uuid]  # la nube ya no los tiene (p. ej. base restaurada)
    database_free = []

    def probe(request):
        if request.url.path.endswith("/alerts"):
            other = sqlite3.connect(str(db_path), timeout=0)
            try:
                other.execute("BEGIN IMMEDIATE")
                other.execute("ROLLBACK")
                database_free.append(True)
            finally:
                other.close()
        return None

    cloud.fail = probe
    with pytest.raises(SyncBlocked):
        engine_for(db_path, cloud).reconcile()

    assert cloud.alerts == [{"type": "mass_delete_blocked", "table": "cards", "would_delete": 30, "total": 100}]
    assert database_free == [True]
    assert len(card_codes(conn)) == 100


# --- adopt_cloud ------------------------------------------------------------------------------

def test_adopt_cloud_backs_up_keeps_local_outputs_empties_the_outbox_and_saves_r0(conn, db_path, cloud):
    local_id = new_holder(conn, "Local", pin="1234")
    cards.create_card(conn, 1, local_id, "")
    conn.execute("UPDATE outputs SET alias='Pluma local' WHERE output_id=0")
    assert outbox(conn) != []

    # La nube: otro titular, otra tarjeta, su perfil 0 y las salidas con UUID de la nube.
    cloud_holder, cloud_perm = str(uuid.uuid4()), str(uuid.uuid4())
    cloud.put("holders", cloud_holder, holder_data("Nube", pin="9999"))
    cloud.put("cards", str(uuid.uuid4()), {"card_code": 2, "holder_id": cloud_holder, "description": ""})
    cloud.put("permissions", cloud_perm, {"permission_id": 0, "name": "Todo", "output_mask": 15,
                                          "card_reader_mask": 15, "pin_reader_mask": 0, "allow_rf": True,
                                          "weekday_mask": 127, "start_minute": 0, "end_minute": 0})
    cloud.put("holder_permissions", str(uuid.uuid4()), {"holder_id": cloud_holder, "permission_id": 0})
    output_uuids = {}
    for output_id in range(4):
        output_uuids[output_id] = str(uuid.uuid4())
        cloud.put("outputs", output_uuids[output_id], {"output_id": output_id, "alias": "Nube",
                                                       "duration_ms": 1000, "reader_mask": 1, "enabled": True})
    r0 = cloud.revision
    cloud.after_checksums = lambda: cloud.put("cards", str(uuid.uuid4()), {
        "card_code": 3, "holder_id": cloud_holder, "description": ""})

    engine_for(db_path, cloud).adopt_cloud()

    backups = list(db_path.parent.glob("test_backup_adopt*.sqlite"))
    assert len(backups) == 1 and stat.S_IMODE(os.stat(str(backups[0])).st_mode) == 0o600
    assert [r[0] for r in conn.execute("SELECT name FROM holders")] == ["Nube"]
    assert 1 not in card_codes(conn) and 2 in card_codes(conn)
    out0 = conn.execute("SELECT alias, duration_ms, uuid FROM outputs WHERE output_id=0").fetchone()
    assert (out0["alias"], out0["duration_ms"], out0["uuid"]) == ("Pluma local", 3000, output_uuids[0])
    assert {r[0] for r in conn.execute("SELECT uuid FROM outputs")} == set(output_uuids.values())
    assert uuid_of(conn, "permissions", "permission_id=0") == cloud_perm
    # La bandeja se vació; solo quedan las salidas, cuyos valores locales difieren de la nube.
    assert sorted((e["table_name"], e["row_uuid"]) for e in outbox(conn)) == sorted(
        ("outputs", u) for u in output_uuids.values())
    assert cursor(conn) == r0
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


# --- logs -------------------------------------------------------------------------------------

def test_upload_logs_sends_pin_logs_without_code_and_the_holder_as_uuid(conn, db_path, cloud):
    holder_id = new_holder(conn, "Ana", pin="4321")
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    insert = ("INSERT INTO access_logs(timestamp, allowed, source, holder_id, holder_name, holder_kind,"
              " credential_label, control_id, code, device_id, output_id, reason)"
              " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    conn.execute(insert, (1_790_000_000, 1, 3, holder_id, "Ana", "persona", "PIN", None, 4321, 1, 0, 0))
    conn.execute(insert, (1_790_000_060, 0, 0, None, None, None, None, None, 99, 2, None, 1))
    engine = engine_for(db_path, cloud)

    assert engine.upload_logs() == 2

    pin_log, card_log = cloud.logs
    assert pin_log["source"] == 3 and pin_log["code"] is None
    assert pin_log["holder_id"] == holder_uuid and pin_log["control_id"] is None
    assert pin_log["timestamp"] == "2026-09-21T14:13:20.000Z"
    assert pin_log["allowed"] is True and card_log["code"] == 99 and card_log["holder_id"] is None
    body = json.dumps([b for m, p, _, b in cloud.requests if p == "/logs"])
    assert "4321" not in body
    assert get_state(conn, "last_log_uploaded") == str(card_log["local_log_id"])

    assert engine.upload_logs() == 0
    assert len(cloud.paths("POST")) == 1


def test_upload_logs_always_post_without_pending_logs_posts_an_empty_list(conn, db_path, cloud):
    engine = engine_for(db_path, cloud)
    assert engine.upload_logs() == 0
    assert cloud.paths("POST") == []   # sin `always_post` no se llama a la nube
    assert engine.upload_logs(always_post=True) == 0
    assert [b for m, p, _, b in cloud.requests if p == "/logs"] == [{"logs": []}]
    assert cloud.logs_uploads == 1 and get_state(conn, "last_log_uploaded") is None


def test_upload_logs_always_post_with_pending_logs_does_not_add_an_empty_post(conn, db_path, cloud):
    conn.execute("INSERT INTO access_logs(timestamp, allowed, source, credential_label, output_id, reason)"
                 " VALUES (1790000000, 1, 5, 'Prueba — ana@example.com', 2, 0)")
    engine = engine_for(db_path, cloud)
    assert engine.upload_logs(always_post=True) == 1
    assert cloud.logs_uploads == 1
    (test_log,) = cloud.logs
    assert test_log["source"] == 5 and test_log["output_id"] == 2   # el origen "Prueba" sube tal cual
    assert test_log["credential_label"] == "Prueba — ana@example.com"


def test_engine_start_resets_the_agent_guard(conn, db_path, cloud):
    conn.execute("UPDATE sync_guard SET applying=1 WHERE id=1")

    engine_for(db_path, cloud)

    assert conn.execute("SELECT applying FROM sync_guard").fetchone()[0] == 0


# --- corrección 1: cascadas que no deben borrar lo que la nube conserva -------------------------

BUTTONS = [ButtonData(555, 0)] + [ButtonData(None, None)] * 3


def _two_holders_with_control(conn, pin=None):
    """A (con `pin`) con un control (1 botón), una tarjeta y su permiso 0; B sin nada."""
    a_id = new_holder(conn, "A", pin=pin)
    b_id = new_holder(conn, "B", permission_ids=())
    controls.create_control(conn, a_id, "Control", BUTTONS)
    cards.create_card(conn, 5, a_id, "")
    ids = {name: uuid_of(conn, "holders", "holder_id=?", (hid,)) for name, hid in (("A", a_id), ("B", b_id))}
    ids["control"] = uuid_of(conn, "controls", "holder_id=?", (a_id,))
    ids["button"] = uuid_of(conn, "control_buttons", "rf_code=555")
    ids["card"] = uuid_of(conn, "cards", "card_code=5")
    ids["assignment"] = uuid_of(conn, "holder_permissions", "holder_id=?", (a_id,))
    return ids


def _move_everything_to_b_and_delete_a(cloud, ids):
    cloud.put("controls", ids["control"], dict(cloud.live_row("controls", ids["control"]), holder_id=ids["B"]))
    cloud.put("cards", ids["card"], dict(cloud.live_row("cards", ids["card"]), holder_id=ids["B"]))
    cloud.put("holder_permissions", ids["assignment"],
              dict(cloud.live_row("holder_permissions", ids["assignment"]), holder_id=ids["B"]))
    cloud.remove("holders", ids["A"])


def _owner_of(conn, table, row_uuid):
    return conn.execute("SELECT h.uuid FROM %s t JOIN holders h ON h.holder_id = t.holder_id"
                        " WHERE t.uuid=?" % table, (row_uuid,)).fetchone()[0]


def _assert_everything_moved_to_b(conn, ids):
    assert [r[0] for r in conn.execute("SELECT name FROM holders")] == ["B"]
    assert _owner_of(conn, "controls", ids["control"]) == ids["B"]
    assert _owner_of(conn, "cards", ids["card"]) == ids["B"]
    assert _owner_of(conn, "holder_permissions", ids["assignment"]) == ids["B"]
    assert [tuple(r) for r in conn.execute("SELECT rf_code, uuid FROM control_buttons")] == [(555, ids["button"])]
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_pull_that_moves_a_control_and_deletes_its_holder_keeps_the_buttons(conn, db_path, cloud):
    ids = _two_holders_with_control(conn)
    mark_synced(conn, cloud)
    _move_everything_to_b_and_delete_a(cloud, ids)

    engine_for(db_path, cloud).pull()

    _assert_everything_moved_to_b(conn, ids)
    assert outbox(conn) == []


def test_reconcile_that_replaces_holders_and_controls_keeps_buttons_it_does_not_download(conn, db_path, cloud):
    ids = _two_holders_with_control(conn)
    mark_synced(conn, cloud)
    _move_everything_to_b_and_delete_a(cloud, ids)

    replaced = engine_for(db_path, cloud).reconcile()

    assert "control_buttons" not in replaced
    _assert_everything_moved_to_b(conn, ids)


@pytest.mark.parametrize("pin", [None, "1234"])
def test_adopt_with_a_holder_matched_by_name_keeps_the_control_buttons(conn, db_path, cloud, pin):
    # Con PIN es el caso normal: la importación da al titular emparejado el PIN del panel.
    ids = _two_holders_with_control(conn, pin=pin)
    local = snapshot_tables(conn)
    # La importación emparejó a "A" con un titular de la nube (otro UUID) y conservó los demás UUID.
    for table in ("permissions", "outputs", "control_buttons"):
        for row in local[table]:
            cloud.put(table, row["id"], row["data"])
    cloud.put("holders", ids["B"], holder_data("B"))
    matched = str(uuid.uuid4())
    cloud.put("holders", matched, holder_data("A", pin))
    cloud.put("controls", ids["control"], {"holder_id": matched, "description": "Control"})
    cloud.put("cards", ids["card"], {"card_code": 5, "holder_id": matched, "description": ""})
    cloud.put("holder_permissions", ids["assignment"], {"holder_id": matched, "permission_id": 0})

    engine_for(db_path, cloud).adopt_cloud()

    assert _owner_of(conn, "controls", ids["control"]) == matched
    assert _owner_of(conn, "cards", ids["card"]) == matched
    assert _owner_of(conn, "holder_permissions", ids["assignment"]) == matched
    assert [tuple(r) for r in conn.execute("SELECT rf_code, uuid FROM control_buttons")] == [(555, ids["button"])]
    assert [tuple(r) for r in conn.execute("SELECT name, pin FROM holders ORDER BY name")] == [
        ("A", pin), ("B", None)]
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_pull_where_a_new_holder_takes_everything_and_the_pin_of_a_deleted_one_keeps_it_all(
        conn, db_path, cloud):
    ids = _two_holders_with_control(conn, pin="1234")
    conn.execute("DELETE FROM holders WHERE uuid=?", (ids["B"],))
    mark_synced(conn, cloud)
    ids["B"] = str(uuid.uuid4())
    cloud.put("holders", ids["B"], holder_data("B"))
    _move_everything_to_b_and_delete_a(cloud, ids)
    cloud.put("holders", ids["B"], holder_data("B", "1234"))

    engine_for(db_path, cloud).pull()

    _assert_everything_moved_to_b(conn, ids)
    assert conn.execute("SELECT pin FROM holders").fetchall()[0][0] == "1234"
    assert cursor(conn) == cloud.revision


def test_pull_that_recreates_a_permission_with_the_same_number_keeps_the_assignment(conn, db_path, cloud):
    conn.execute("INSERT INTO permissions(permission_id, name, output_mask, card_reader_mask, pin_reader_mask,"
                 " weekday_mask, start_minute, end_minute, allow_rf, uuid, updated_at)"
                 " VALUES (1, 'Viejo', 1, 15, 0, 127, 0, 0, 1, ?, 1)", (str(uuid.uuid4()),))
    holder_id = new_holder(conn, "H", permission_ids=(1,))
    mark_synced(conn, cloud)
    old = uuid_of(conn, "permissions", "permission_id=1")
    old_assignment = uuid_of(conn, "holder_permissions", "holder_id=?", (holder_id,))
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    data = dict(cloud.live_row("permissions", old), name="Nuevo")
    cloud.remove("holder_permissions", old_assignment)
    cloud.remove("permissions", old)
    new = str(uuid.uuid4())
    cloud.put("permissions", new, data)
    assignment = str(uuid.uuid4())
    cloud.put("holder_permissions", assignment, {"holder_id": holder_uuid, "permission_id": 1})

    engine_for(db_path, cloud).pull()

    assert uuid_of(conn, "permissions", "permission_id=1") == new
    assert [tuple(r) for r in conn.execute("SELECT permission_id, uuid FROM holder_permissions")] == [
        (1, assignment)]


def test_pull_that_moves_a_button_to_a_new_control_and_deletes_the_old_one_keeps_the_button(
        conn, db_path, cloud):
    ids = _two_holders_with_control(conn)
    mark_synced(conn, cloud)
    new_control = str(uuid.uuid4())
    cloud.put("controls", new_control, {"holder_id": ids["A"], "description": "Nuevo"})
    cloud.put("control_buttons", ids["button"],
              dict(cloud.live_row("control_buttons", ids["button"]), control_id=new_control))
    cloud.remove("controls", ids["control"])

    engine_for(db_path, cloud).pull()

    assert [tuple(r) for r in conn.execute(
        "SELECT k.uuid, b.uuid, b.rf_code FROM control_buttons b JOIN controls k USING(control_id)")] == [
        (new_control, ids["button"], 555)]


def test_pull_that_moves_a_pending_control_lets_the_cloud_win_instead_of_cascading(conn, db_path, cloud):
    ids = _two_holders_with_control(conn)
    mark_synced(conn, cloud)
    _move_everything_to_b_and_delete_a(cloud, ids)
    control_id = conn.execute("SELECT control_id FROM controls").fetchone()[0]
    a_id = conn.execute("SELECT holder_id FROM holders WHERE uuid=?", (ids["A"],)).fetchone()[0]
    controls.update_control(conn, control_id, a_id, "Editado", BUTTONS)

    engine_for(db_path, cloud).pull()

    _assert_everything_moved_to_b(conn, ids)
    assert ids["control"] not in [e["row_uuid"] for e in outbox(conn)]
    assert get_state(conn, "last_error")


# --- corrección 1: liberar llaves únicas de filas con cambios pendientes -------------------------

def test_pin_taken_from_a_pending_holder_applies_the_cloud_version_and_uploads_nothing(conn, db_path, cloud):
    a_id = new_holder(conn, "A", pin="1234")
    mark_synced(conn, cloud)
    a = uuid_of(conn, "holders", "holder_id=?", (a_id,))
    cloud.put("holders", a, holder_data("A", "5555"))
    cloud.put("holders", str(uuid.uuid4()), holder_data("B", "1234"))
    holders.update_holder(conn, a_id, HolderData(kind="persona", name="A", notes="editado", pin="1234",
                                                 permission_ids=(0,)))
    engine = engine_for(db_path, cloud)

    engine.pull()

    assert conn.execute("SELECT pin FROM holders WHERE uuid=?", (a,)).fetchone()[0] == "5555"
    assert a not in [e["row_uuid"] for e in outbox(conn)]
    error = get_state(conn, "last_error")
    assert error and "1234" not in error and "5555" not in error
    engine.push()
    assert all(i["id"] != a for batch in cloud.pushed for i in batch)
    assert cloud.live_row("holders", a)["pin"] == "5555"


def test_card_code_taken_from_a_pending_card_applies_the_cloud_version(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "X")
    mark_synced(conn, cloud)
    x = uuid_of(conn, "cards", "card_code=5")
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    cloud.put("cards", x, {"card_code": 6, "holder_id": holder_uuid, "description": "X"})
    y = str(uuid.uuid4())
    cloud.put("cards", y, {"card_code": 5, "holder_id": holder_uuid, "description": "Y"})
    cards.update_card(conn, 5, holder_id, "X editada")

    engine_for(db_path, cloud).pull()

    assert uuid_of(conn, "cards", "card_code=5") == y
    assert uuid_of(conn, "cards", "card_code=6") == x
    assert cards.get_card(conn, 6)["description"] == "X"
    assert outbox(conn) == []
    assert get_state(conn, "last_error")


def test_a_pending_local_card_whose_code_the_cloud_gave_away_is_deleted_with_its_entries(conn, db_path, cloud):
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    cards.create_card(conn, 7, holder_id, "local")
    y = str(uuid.uuid4())
    cloud.put("cards", y, {"card_code": 7, "holder_id": holder_uuid, "description": "nube"})

    engine_for(db_path, cloud).pull()

    assert uuid_of(conn, "cards", "card_code=7") == y
    assert outbox(conn) == []


# --- corrección 1: menores ----------------------------------------------------------------------

def test_push_without_a_result_for_every_change_leaves_the_outbox_untouched(conn, db_path, cloud):
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    cards.create_card(conn, 5, holder_id, "")
    before = outbox(conn)
    cloud.fail = lambda r: (httpx.Response(200, json={"revision": 1, "results": []})
                            if r.method == "POST" else None)

    with pytest.raises(CloudError):
        engine_for(db_path, cloud).push()

    assert outbox(conn) == before


def test_push_network_failure_keeps_the_outbox_and_retries_with_the_same_change_id(conn, db_path, cloud):
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    cards.create_card(conn, 5, holder_id, "")
    [entry] = outbox(conn)

    def down(request):
        raise httpx.ConnectError("sin red")

    cloud.fail = down
    engine = engine_for(db_path, cloud)
    with pytest.raises(CloudError):
        engine.push()
    assert outbox(conn) == [entry]

    cloud.fail = None
    assert engine.push() == 1
    assert cloud.pushed[0][0]["change_id"] == entry["change_id"]
    assert outbox(conn) == []


def test_push_sends_more_than_a_page_in_several_batches_in_order(conn, db_path, cloud, monkeypatch):
    monkeypatch.setattr(sync, "CHANGES_PAGE", 2)
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    for code in (1, 2, 3, 4, 5):
        cards.create_card(conn, code, holder_id, "")

    assert engine_for(db_path, cloud).push() == 5

    assert [len(b) for b in cloud.pushed] == [2, 2, 1]
    assert [i["data"]["card_code"] for b in cloud.pushed for i in b] == [1, 2, 3, 4, 5]
    assert outbox(conn) == []


def test_pull_skips_a_row_whose_parent_has_a_pending_local_delete_and_applies_the_rest(conn, db_path, cloud):
    gone_id = new_holder(conn, "Se va")
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    gone = uuid_of(conn, "holders", "holder_id=?", (gone_id,))
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    holders.delete_holder(conn, gone_id)  # borrado local pendiente de subir
    cloud.put("cards", str(uuid.uuid4()), {"card_code": 1, "holder_id": gone, "description": ""})
    cloud.put("cards", str(uuid.uuid4()), {"card_code": 2, "holder_id": holder_uuid, "description": ""})

    engine_for(db_path, cloud).pull()

    assert card_codes(conn) == [2]
    assert cursor(conn) == cloud.revision


def test_pull_with_a_row_whose_parent_is_missing_for_no_reason_fails_without_applying(conn, db_path, cloud):
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    start = cursor(conn)
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    cloud.put("cards", str(uuid.uuid4()), {"card_code": 1, "holder_id": str(uuid.uuid4()), "description": ""})
    cloud.put("cards", str(uuid.uuid4()), {"card_code": 2, "holder_id": holder_uuid, "description": ""})

    with pytest.raises(InvalidChange) as error:
        engine_for(db_path, cloud).pull()

    assert "no existe en el panel" in str(error.value)
    assert card_codes(conn) == []
    assert cursor(conn) == start


def test_pull_delete_de_uuid_desconocido_no_falla(conn, db_path, cloud):
    # Con controles por panel, la nube manda a todos los paneles el borrado de un botón (y de su
    # control) que solo estaba vinculado a otro panel: este panel nunca los tuvo y los ignora.
    ids = _two_holders_with_control(conn)
    mark_synced(conn, cloud)
    cloud.remove("control_buttons", str(uuid.uuid4()))
    cloud.remove("controls", str(uuid.uuid4()))

    assert engine_for(db_path, cloud).pull() == 2

    assert cursor(conn) == cloud.revision
    assert [r[0] for r in conn.execute("SELECT uuid FROM controls")] == [ids["control"]]
    assert [r[0] for r in conn.execute("SELECT uuid FROM control_buttons")] == [ids["button"]]
    assert get_state(conn, "last_error") is None
    assert cloud.alerts == []
    assert outbox(conn) == []


def test_an_unknown_table_from_the_cloud_fails_with_a_clear_spanish_message(conn):
    with pytest.raises(InvalidChange) as error:
        apply_batch(conn, [{"table": "visitas", "op": "upsert", "id": str(uuid.uuid4()), "data": {}}])

    assert str(error.value) == "La nube envió un cambio de una tabla desconocida: visitas."


def test_pull_that_would_delete_most_holders_is_blocked(conn, db_path, cloud):
    for n in range(12):
        new_holder(conn, "T%d" % n, permission_ids=())
    mark_synced(conn, cloud)
    for row in snapshot_tables(conn)["holders"][:10]:
        cloud.remove("holders", row["id"])

    with pytest.raises(SyncBlocked):
        engine_for(db_path, cloud).pull()

    assert cloud.alerts == [{"type": "mass_delete_blocked", "table": "holders", "would_delete": 10, "total": 12}]
    assert conn.execute("SELECT COUNT(*) FROM holders").fetchone()[0] == 12


def test_adopt_queues_local_output_values_that_differ_from_the_cloud(conn, db_path, cloud):
    local = snapshot_tables(conn)
    for table in ("permissions", "outputs"):
        for row in local[table]:
            cloud.put(table, row["id"], row["data"])
    conn.execute("UPDATE outputs SET alias='Pluma' WHERE output_id=1")
    out1 = uuid_of(conn, "outputs", "output_id=1")

    engine_for(db_path, cloud).adopt_cloud()

    assert [(e["table_name"], e["op"], e["row_uuid"]) for e in outbox(conn)] == [("outputs", "upsert", out1)]


def test_adopt_keeps_at_most_three_backups(conn, db_path, cloud):
    for n in range(4):
        old = db_path.with_name("test_backup_adopt.2026010%d-000000.sqlite" % n)
        old.write_bytes(b"")
        os.utime(str(old), (1_700_000_000 + n, 1_700_000_000 + n))
    db_path.with_name("test_backup_adopt.sqlite").write_bytes(b"")

    engine_for(db_path, cloud).adopt_cloud()

    assert len(list(db_path.parent.glob("test_backup_adopt*.sqlite"))) == 3


# --- corrección 3: un `current` del push con padre que el panel aún no tiene ----------------------

def test_push_current_whose_parent_is_not_in_the_panel_yet_is_skipped_and_the_pull_brings_it(
        conn, db_path, cloud):
    holder_id = new_holder(conn, "A")
    cards.create_card(conn, 5, holder_id, "")
    cards.create_card(conn, 6, holder_id, "")
    mark_synced(conn, cloud)
    card = uuid_of(conn, "cards", "card_code=5")
    other = uuid_of(conn, "cards", "card_code=6")
    new_holder_uuid = str(uuid.uuid4())
    cloud.put("holders", new_holder_uuid, holder_data("N"))
    cloud.put("cards", card, {"card_code": 5, "holder_id": new_holder_uuid, "description": ""})
    cards.update_card(conn, 5, holder_id, "editada")
    cards.update_card(conn, 6, holder_id, "también")
    cloud.forced[card] = ("superseded", None)
    engine = engine_for(db_path, cloud)

    assert engine.push() == 2  # sin error: el resto de la página se procesa

    assert outbox(conn) == []
    assert cards.get_card(conn, 5)["description"] == "editada"  # la fila local queda como está
    assert cloud.live_row("cards", other)["description"] == "también"

    engine.pull()

    assert _owner_of(conn, "cards", card) == new_holder_uuid
    assert cards.get_card(conn, 5)["description"] == ""
    assert engine.push() == 0 and outbox(conn) == []


# --- revisión final: respaldo de adopt_cloud, PIN duplicado y borrados de la nube ----------------

def _adopt_backups(db_path):
    return sorted(db_path.parent.glob("test_backup_adopt*.sqlite"))


def test_adopt_backs_up_after_downloading_the_snapshots(conn, db_path, cloud):
    def no_snapshot(request):
        if request.url.path.endswith("/snapshot"):
            return httpx.Response(503, json={"code": "http_error", "message": "caída"})
        return None

    cloud.fail = no_snapshot
    with pytest.raises(CloudError):
        engine_for(db_path, cloud).adopt_cloud()

    assert _adopt_backups(db_path) == []   # la descarga falló: no se copió la base


def test_adopt_retries_back_up_the_database_only_once(conn, db_path, cloud):
    new_holder(conn, "Local")
    holder = str(uuid.uuid4())
    cloud.put("cards", str(uuid.uuid4()), {"card_code": 1, "holder_id": holder, "description": ""})
    engine = engine_for(db_path, cloud)

    for _ in range(3):   # la nube manda una tarjeta sin titular: la adopción falla en cada reintento
        with pytest.raises(InvalidChange):
            engine.adopt_cloud()

    [backup] = _adopt_backups(db_path)
    assert get_state(conn, sync.ADOPT_BACKUP_KEY) == "1"

    cloud.put("holders", holder, holder_data("Nube"))
    engine.adopt_cloud()

    assert _adopt_backups(db_path) == [backup]   # el reintento que sí adopta tampoco respalda otra vez
    assert get_state(conn, sync.ADOPT_BACKUP_KEY) is None   # la próxima adopción respalda de nuevo
    assert [r[0] for r in conn.execute("SELECT name FROM holders")] == ["Nube"]


def test_a_new_holder_rejected_as_duplicate_keeps_its_cards_loses_the_pin_and_is_requeued(conn, db_path, cloud):
    mark_synced(conn, cloud)
    holder_id = new_holder(conn, "Ana", pin="1234")
    cards.create_card(conn, 5, holder_id, "Llavero")
    controls.create_control(conn, holder_id, "Control", BUTTONS)
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    children = [uuid_of(conn, "cards", "card_code=5"), uuid_of(conn, "controls", "holder_id=?", (holder_id,)),
                uuid_of(conn, "control_buttons", "rf_code=555"),
                uuid_of(conn, "holder_permissions", "holder_id=?", (holder_id,))]
    # La nube: el PIN ya lo tiene otro titular (el alta no existe allá, current null) y los hijos
    # no encuentran a su titular.
    cloud.forced[holder_uuid] = ("rejected", "duplicado")
    for child in children:
        cloud.forced[child] = ("rejected", "relacionado no existe")
    engine = engine_for(db_path, cloud)

    engine.push()

    row = conn.execute("SELECT name, pin FROM holders WHERE uuid=?", (holder_uuid,)).fetchone()
    assert tuple(row) == ("Ana", None)
    assert card_codes(conn) == [5]
    assert conn.execute("SELECT COUNT(*) FROM controls").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM control_buttons").fetchone()[0] == 1
    assert {e["row_uuid"] for e in outbox(conn)} == {holder_uuid, *children}
    error = get_state(conn, "last_error")
    assert "PIN" in error and "Ana" in error and "1234" not in error

    cloud.forced.clear()
    engine.push()

    assert cloud.live_row("holders", holder_uuid) == holder_data("Ana", None)
    assert all(cloud.live_row(t, c) is not None for t, c in zip(
        ("cards", "controls", "control_buttons", "holder_permissions"), children))
    assert outbox(conn) == []


def test_an_update_rejected_as_duplicate_still_applies_the_cloud_version(conn, db_path, cloud):
    holder_id = new_holder(conn, "Ana", pin="1111")
    mark_synced(conn, cloud)
    holder_uuid = uuid_of(conn, "holders", "holder_id=?", (holder_id,))
    holders.update_holder(conn, holder_id, HolderData(kind="persona", name="Ana", pin="2222",
                                                      permission_ids=(0,)))
    cloud.forced[holder_uuid] = ("rejected", "duplicado")

    engine_for(db_path, cloud).push()

    assert conn.execute("SELECT pin FROM holders WHERE uuid=?", (holder_uuid,)).fetchone()[0] == "1111"
    assert outbox(conn) == []


def test_pull_applies_a_cloud_delete_of_a_card_with_pending_local_changes(conn, db_path, cloud):
    holder_id = new_holder(conn)
    cards.create_card(conn, 5, holder_id, "")
    cards.create_card(conn, 6, holder_id, "")
    mark_synced(conn, cloud)
    card = uuid_of(conn, "cards", "card_code=5")
    cards.update_card(conn, 5, holder_id, "editada")   # su push está fallando
    cards.update_card(conn, 6, holder_id, "también")
    cloud.remove("cards", card)   # revocada en la nube

    engine_for(db_path, cloud).pull()

    assert card_codes(conn) == [6]
    assert [e["row_uuid"] for e in outbox(conn)] == [uuid_of(conn, "cards", "card_code=6")]
    assert get_state(conn, "last_error")
    assert cursor(conn) == cloud.revision


def test_pull_deletes_a_pending_holder_but_keeps_what_the_cloud_moved_to_another(conn, db_path, cloud):
    ids = _two_holders_with_control(conn)
    mark_synced(conn, cloud)
    _move_everything_to_b_and_delete_a(cloud, ids)
    a_id = conn.execute("SELECT holder_id FROM holders WHERE uuid=?", (ids["A"],)).fetchone()[0]
    holders.update_holder(conn, a_id, HolderData(kind="persona", name="A", notes="editado",
                                                 permission_ids=(0,)))
    assert ids["A"] in [e["row_uuid"] for e in outbox(conn)]

    engine_for(db_path, cloud).pull()

    _assert_everything_moved_to_b(conn, ids)
    assert outbox(conn) == []


def test_pull_deletes_a_pending_holder_and_its_cascade(conn, db_path, cloud):
    ids = _two_holders_with_control(conn)
    mark_synced(conn, cloud)
    a_id = conn.execute("SELECT holder_id FROM holders WHERE uuid=?", (ids["A"],)).fetchone()[0]
    cards.update_card(conn, 5, a_id, "editada")
    holders.update_holder(conn, a_id, HolderData(kind="persona", name="A", notes="editado",
                                                 permission_ids=(0,)))
    for table, key in (("control_buttons", "button"), ("controls", "control"), ("cards", "card"),
                       ("holder_permissions", "assignment"), ("holders", "A")):
        cloud.remove(table, ids[key])   # la nube borra al titular con todo lo suyo

    engine_for(db_path, cloud).pull()

    assert [r[0] for r in conn.execute("SELECT name FROM holders")] == ["B"]
    assert card_codes(conn) == []
    assert conn.execute("SELECT COUNT(*) FROM controls").fetchone()[0] == 0
    assert outbox(conn) == []
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_pull_counts_pending_rows_in_the_mass_delete_protection(conn, db_path, cloud):
    card_uuids = _cards_synced(conn, cloud, 40)
    holder_id = conn.execute("SELECT holder_id FROM holders").fetchone()[0]
    for code in range(1, 11):
        cards.update_card(conn, code, holder_id, "editada")
    for card_uuid in card_uuids[:10]:
        cloud.remove("cards", card_uuid)

    with pytest.raises(SyncBlocked) as blocked:
        engine_for(db_path, cloud).pull()

    assert blocked.value.would_delete == 10
    assert len(card_codes(conn)) == 40


def test_reconcile_keeps_a_pending_local_row_the_cloud_does_not_have(conn, db_path, cloud):
    holder_id = new_holder(conn)
    mark_synced(conn, cloud)
    cards.create_card(conn, 5, holder_id, "nueva")   # alta local cuyo push está fallando

    engine_for(db_path, cloud).reconcile()

    assert card_codes(conn) == [5]
    assert [e["table_name"] for e in outbox(conn)] == ["cards"]
