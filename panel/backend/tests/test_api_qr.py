import time
from datetime import datetime, timedelta, timezone

from helpers import add_holder


def _iso(offset_s):
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_s)).isoformat()


def _post(client, holder_id, frm=-3600, until=3600, max_uses=1, label="Visita"):
    return client.post("/api/qr-codes", json={"holder_id": holder_id, "label": label,
                                              "valid_from": _iso(frm), "valid_until": _iso(until),
                                              "max_uses": max_uses})


def test_create_qr_returns_code_in_range(client, db):
    h = add_holder(db)
    r = client.post("/api/qr-codes", json={"holder_id": h, "label": "Visita",
                                           "valid_from": "2026-12-01T09:00:00-06:00",
                                           "valid_until": "2026-12-01T18:00:00-06:00", "max_uses": 1})
    assert r.status_code == 201
    body = r.json()
    assert 900000000 <= body["code"] <= 999999999
    assert body["valid_from"] == "2026-12-01T15:00:00Z" and body["valid_until"] == "2026-12-02T00:00:00Z"
    assert body["status"] == "pending" and body["uses"] == {} and body["holder_name"] == "Amadeo 1260"


def test_list_status_uses_and_filter(client, db):
    h1 = add_holder(db)
    h2 = add_holder(db, name="Ana", kind="persona")
    active = _post(client, h1).json()
    pending = _post(client, h1, frm=600, until=1200).json()
    _post(client, h2)
    db.execute("INSERT INTO qr_uses(qr_id, reader, count) VALUES (?, 2, 3)", (active["qr_id"],))
    rows = client.get("/api/qr-codes", params={"holder_id": h1}).json()
    by_id = {r["qr_id"]: r for r in rows}
    assert len(rows) == 2
    assert by_id[active["qr_id"]]["status"] == "active" and by_id[active["qr_id"]]["uses"] == {"2": 3}
    assert by_id[pending["qr_id"]]["status"] == "pending"
    assert len(client.get("/api/qr-codes").json()) == 3


def test_qr_limit_422(client, db):
    h = add_holder(db)
    db.execute("UPDATE qr_settings SET max_active = 1")
    now = int(time.time())
    # Uno vencido no cuenta.
    db.execute("INSERT INTO qr_codes(holder_id, code, valid_from, valid_until, created_at, uuid, updated_at)"
               " VALUES (?, 911111111, ?, ?, ?, 'u1', 1)", (h, now - 200, now - 100, now - 200))
    assert _post(client, h).status_code == 201
    r = _post(client, h)
    assert r.status_code == 422
    assert r.json() == {"detail": "Se alcanzó el máximo de QR vigentes de la instalación."}


def test_qr_bad_validity_422(client, db):
    h = add_holder(db)
    r = _post(client, h, frm=100, until=100)
    assert r.status_code == 422 and r.json() == {"detail": "La vigencia debe terminar después de empezar."}
    r = client.post("/api/qr-codes", json={"holder_id": h, "valid_from": "2026-12-01T09:00:00",
                                           "valid_until": "2026-12-01T10:00:00-06:00"})
    assert r.status_code == 422 and "zona horaria" in r.json()["detail"]
    assert _post(client, h, max_uses=0).status_code == 422
    assert _post(client, h, max_uses=101).status_code == 422
    assert _post(client, h, label="x" * 61).status_code == 422
    assert _post(client, h, label="x" * 60).status_code == 201


def test_unknown_holder_422(client, db):
    r = _post(client, 99)
    assert r.status_code == 422 and r.json() == {"detail": "El titular 99 no existe."}


def test_no_free_code_503(client, db, monkeypatch):
    from acceso import qr
    h = add_holder(db)
    monkeypatch.setattr(qr, "GENERATE_ATTEMPTS", 0)
    r = _post(client, h)
    assert r.status_code == 503 and r.json() == {"detail": "No se pudo generar un código de QR único."}


def test_delete_qr_enqueues_delete(client, db):
    h = add_holder(db)
    qr = _post(client, h).json()
    db.execute("DELETE FROM sync_outbox")
    assert client.delete("/api/qr-codes/%d" % qr["qr_id"]).status_code == 204
    ops = [tuple(r) for r in db.execute("SELECT table_name, op FROM sync_outbox")]
    assert ("qr_codes", "delete") in ops
    assert client.delete("/api/qr-codes/%d" % qr["qr_id"]).status_code == 404


def test_card_in_qr_range_422(client, db):
    h = add_holder(db)
    r = client.post("/api/cards", json={"card_code": 912345678, "holder_id": h, "description": ""})
    assert r.status_code == 422 and r.json() == {"detail": "Ese código está reservado para QR."}
    client.post("/api/cards", json={"card_code": 123, "holder_id": h, "description": ""})
    # update también valida (la tarjeta existente no cambia de código, pero el rango se revisa)
    db.execute("INSERT INTO cards(card_code, holder_id, uuid, updated_at) VALUES (955555555, ?, 'c1', 1)", (h,))
    # Una tarjeta ya registrada en el rango (legada) se puede editar.
    r = client.put("/api/cards/955555555", json={"holder_id": h, "description": "x"})
    assert r.status_code == 200 and r.json()["description"] == "x"


def test_digit_change_with_cards_in_range_422(client, db):
    h = add_holder(db)
    db.execute("INSERT INTO cards(card_code, holder_id, uuid, updated_at) VALUES (800000001, ?, 'c1', 1)", (h,))
    r = client.put("/api/qr-settings", json={"digit": 8, "max_active": 10})
    assert r.status_code == 422 and r.json()["detail"].startswith("Hay tarjetas en ese rango")
    r = client.put("/api/qr-settings", json={"digit": 7, "max_active": 10})
    assert r.status_code == 200 and r.json() == {"digit": 7, "max_active": 10, "editable": True}
    assert client.get("/api/qr-settings").json()["digit"] == 7
    assert client.put("/api/qr-settings", json={"digit": 0, "max_active": 10}).status_code == 422
    assert client.put("/api/qr-settings", json={"digit": 7, "max_active": 100001}).status_code == 422


def test_qr_settings_linked_409(client, db):
    assert client.get("/api/qr-settings").json() == {"digit": 9, "max_active": 1000, "editable": True}
    db.execute("INSERT INTO sync_state(key, value) VALUES ('state', 'active')")
    assert client.get("/api/qr-settings").json()["editable"] is False
    r = client.put("/api/qr-settings", json={"digit": 8, "max_active": 10})
    assert r.status_code == 409
    assert r.json() == {"detail": "El panel está vinculado: el dígito de QR se cambia en la nube."}


def test_permission_qr_reader_mask_roundtrip(client, db):
    body = {"name": "QR", "output_mask": 1, "weekday_mask": 127, "start_minute": 0, "end_minute": 0,
            "card_reader_mask": 0, "pin_reader_mask": 0, "allow_rf": False, "allow_remote": False,
            "qr_reader_mask": 5}
    r = client.post("/api/permissions", json={**body, "permission_id": 3})
    assert r.status_code == 201 and r.json()["qr_reader_mask"] == 5
    r = client.put("/api/permissions/3", json={**body, "qr_reader_mask": 2})
    assert r.json()["qr_reader_mask"] == 2
    old = {k: v for k, v in body.items() if k != "qr_reader_mask"}
    assert client.put("/api/permissions/3", json=old).json()["qr_reader_mask"] == 2
    assert client.put("/api/permissions/3", json={**body, "qr_reader_mask": 16}).status_code == 422
    assert client.get("/api/permissions").json()[0]["qr_reader_mask"] == 0


def test_settings_same_digit_with_cards_in_range_ok(client, db):
    h = add_holder(db)
    db.execute("INSERT INTO cards(card_code, holder_id, uuid, updated_at) VALUES (955555555, ?, 'c1', 1)", (h,))
    r = client.put("/api/qr-settings", json={"digit": 9, "max_active": 50})
    assert r.status_code == 200 and r.json()["max_active"] == 50


def test_settings_linked_max_active_only_409(client, db):
    db.execute("INSERT INTO sync_state(key, value) VALUES ('state', 'active')")
    r = client.put("/api/qr-settings", json={"digit": 9, "max_active": 50})
    assert r.status_code == 409


def test_card_equal_to_existing_qr_other_digit_422(client, db):
    h = add_holder(db)
    db.execute(
        "INSERT INTO qr_codes(holder_id, code, valid_from, valid_until, created_at, uuid, updated_at)"
        " VALUES (?, 912345678, 0, 4102444800000, 0, 'q-viejo', 1)", (h,))
    assert client.put("/api/qr-settings", json={"digit": 5, "max_active": 10}).status_code == 200
    r = client.post("/api/cards", json={"card_code": 912345678, "holder_id": h, "description": ""})
    assert r.status_code == 422 and r.json() == {"detail": "Ese código está reservado para QR."}
    assert client.post("/api/cards", json={"card_code": 912345679, "holder_id": h, "description": ""}).status_code == 201
