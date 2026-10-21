import pytest
from acceso.logs import HolderRef, append_log
from helpers import add_card, add_control


def _create(client, **extra):
    body = {"kind": "domicilio", "name": "Amadeo 1260"}
    body.update(extra)
    return client.post("/api/holders", json=body)


def test_create_and_search(client, db):
    r = _create(client)
    assert r.status_code == 201
    data = r.json()
    assert isinstance(data["holder_id"], int)
    assert data["card_count"] == 0 and data["control_count"] == 0
    assert data["permission_ids"] == []
    found = client.get("/api/holders", params={"q": "amadeo"}).json()
    assert [h["holder_id"] for h in found] == [data["holder_id"]]
    assert client.get("/api/holders", params={"q": "zzz"}).json() == []


def test_list_sorted_case_insensitive(client, db):
    for n in ("beto", "Ana", "carlos"):
        _create(client, kind="persona", name=n)
    assert [h["name"] for h in client.get("/api/holders").json()] == ["Ana", "beto", "carlos"]


def test_blank_name_422(client, db):
    r = _create(client, name="  ")
    assert r.status_code == 422
    assert "El nombre es obligatorio." in r.text


def test_bad_kind_422(client, db):
    assert _create(client, kind="otro").status_code == 422


def test_unknown_permission_422(client, db):
    r = _create(client, permission_ids=[9])
    assert r.status_code == 422
    assert r.json()["detail"] == "El permiso 9 no existe."


def test_permission_out_of_range_422(client, db):
    assert _create(client, permission_ids=[32]).status_code == 422


def test_update_permissions(client, db):
    hid = _create(client, permission_ids=[0]).json()["holder_id"]
    r = client.put(f"/api/holders/{hid}", json={"kind": "persona", "name": "Ana", "permission_ids": []})
    assert r.status_code == 200 and r.json()["permission_ids"] == []
    r = client.put(f"/api/holders/{hid}", json={"kind": "persona", "name": "Ana", "permission_ids": [0]})
    assert r.json()["permission_ids"] == [0] and r.json()["kind"] == "persona"
    assert client.get(f"/api/holders/{hid}").json()["permission_ids"] == [0]


def test_get_and_put_missing_404(client, db):
    r = client.get("/api/holders/99")
    assert r.status_code == 404 and r.json()["detail"] == "El titular 99 no existe."
    assert client.put("/api/holders/99", json={"kind": "persona", "name": "x"}).status_code == 404
    assert client.delete("/api/holders/99").status_code == 404


def test_delete_holder_cascades_and_keeps_log_name(client, db):
    hid = _create(client).json()["holder_id"]
    add_card(db, 123, hid)
    control_id = add_control(db, hid, [(500, 0)])
    append_log(
        db, timestamp=1, allowed=True, source=0, reason=0,
        holder=HolderRef(hid, "Amadeo 1260", "domicilio"), code=123, max_entries=100,
    )
    h = client.get(f"/api/holders/{hid}").json()
    assert h["card_count"] == 1 and h["control_count"] == 1
    assert client.delete(f"/api/holders/{hid}").status_code == 204
    assert db.execute("SELECT COUNT(*) FROM cards").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM controls WHERE control_id=?", (control_id,)).fetchone()[0] == 0
    row = db.execute("SELECT holder_id, holder_name FROM access_logs").fetchone()
    assert row["holder_id"] is None and row["holder_name"] == "Amadeo 1260"


def test_requires_session(anon_client):
    assert anon_client.get("/api/holders").status_code == 401
    assert anon_client.post("/api/holders", json={}).status_code == 401
    assert anon_client.get("/api/holders/1").status_code == 401
    assert anon_client.delete("/api/holders/1").status_code == 401


def test_pin_roundtrip_and_blank_means_none(client, db):
    data = _create(client, pin="0123").json()
    assert data["pin"] == "0123"
    assert client.get(f"/api/holders/{data['holder_id']}").json()["pin"] == "0123"
    assert [h["pin"] for h in client.get("/api/holders").json()] == ["0123"]
    assert _create(client, name="B").json()["pin"] is None
    assert _create(client, name="C", pin="").json()["pin"] is None
    assert _create(client, name="D", pin=None).json()["pin"] is None
    r = client.put(f"/api/holders/{data['holder_id']}",
                   json={"kind": "domicilio", "name": "Amadeo 1260", "pin": ""})
    assert r.json()["pin"] is None


@pytest.mark.parametrize("pin", ["123", "1234567", "12a4", "12 4", "١٢٣٤", 1234])
def test_bad_pin_422_spanish(client, db, pin):
    r = _create(client, pin=pin)
    assert r.status_code == 422
    if isinstance(pin, str):
        assert r.json()["detail"] == "El PIN debe tener de 4 a 6 dígitos."


def test_duplicate_pin_409(client, db):
    _create(client, pin="1234")
    r = _create(client, name="Otro", pin="1234")
    assert r.status_code == 409
    assert r.json()["detail"] == "El PIN ya está asignado a otro titular."
    other = _create(client, name="Otro", pin="1235").json()["holder_id"]
    body = {"kind": "domicilio", "name": "Otro", "pin": "1234"}
    assert client.put(f"/api/holders/{other}", json=body).status_code == 409
    # conservar el propio PIN al editar no es conflicto
    body["pin"] = "1235"
    assert client.put(f"/api/holders/{other}", json=body).status_code == 200
    assert db.execute("SELECT COUNT(*) FROM holders").fetchone()[0] == 2


def test_generate_pin_is_unused_6_digits_and_not_saved(client, db, monkeypatch):
    r = client.post("/api/holders/generate-pin")
    assert r.status_code == 200
    pin = r.json()["pin"]
    assert len(pin) == 6 and pin.isdigit()
    assert db.execute("SELECT COUNT(*) FROM holders").fetchone()[0] == 0

    from acceso.store import holders as store
    values = iter([5, 5, 7])  # 000005 usado, luego 000007
    monkeypatch.setattr(store.secrets, "randbelow", lambda n: next(values))
    _create(client, pin="000005")
    assert client.post("/api/holders/generate-pin").json() == {"pin": "000007"}


def test_generate_pin_requires_session(anon_client):
    assert anon_client.post("/api/holders/generate-pin").status_code == 401
