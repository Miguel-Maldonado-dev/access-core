import pytest

from helpers import add_holder


@pytest.fixture(autouse=True)
def _module_enabled(db):
    db.execute("UPDATE call_settings SET enabled = 1 WHERE id = 1")
    db.commit()


def _post(client, holder_id, number="55 1234-5678", description=""):
    return client.post("/api/phones", json={"holder_id": holder_id, "number": number,
                                            "description": description})


def test_create_phone_normalizes_and_rejects_duplicate(client, db):
    h1, h2 = add_holder(db), add_holder(db, name="Ana", kind="persona")
    r = _post(client, h1)
    assert r.status_code == 201
    assert r.json()["number"] == "5512345678" and r.json()["holder_name"] == "Amadeo 1260"
    r = _post(client, h2, "5512345678")
    assert r.status_code == 409 and r.json() == {"detail": "El número ya está registrado"}


def test_phone_bad_number_422(client, db):
    h = add_holder(db)
    for bad in ("123", "55123456789", "55123abc78", ""):
        r = _post(client, h, bad)
        assert r.status_code == 422 and r.json() == {"detail": "El número debe tener 10 dígitos."}


def test_phone_unknown_holder_422(client, db):
    r = _post(client, 99)
    assert r.status_code == 422 and r.json() == {"detail": "El titular 99 no existe."}


def test_update_list_delete(client, db):
    h1, h2 = add_holder(db), add_holder(db, name="Ana", kind="persona")
    pid = _post(client, h1).json()["phone_id"]
    other = _post(client, h2, "5598765432").json()["phone_id"]
    r = client.put("/api/phones/%d" % pid, json={"holder_id": h2, "number": "5512345678",
                                                  "description": "Casa"})
    assert r.status_code == 200 and r.json()["holder_name"] == "Ana"
    r = client.put("/api/phones/%d" % pid, json={"holder_id": h2, "number": "5598765432",
                                                  "description": ""})
    assert r.status_code == 409
    assert client.put("/api/phones/99", json={"holder_id": h2, "number": "5500000000"}).status_code == 404
    assert len(client.get("/api/phones").json()) == 2
    assert [p["phone_id"] for p in client.get("/api/phones", params={"holder_id": h1}).json()] == []
    assert client.delete("/api/phones/%d" % other).status_code == 204
    assert client.delete("/api/phones/%d" % other).status_code == 404


def test_requires_session(anon_client):
    assert anon_client.get("/api/phones").status_code == 401


def test_create_phone_with_module_disabled_422(client, db):
    db.execute("UPDATE call_settings SET enabled = 0 WHERE id = 1")
    db.commit()
    r = _post(client, add_holder(db))
    assert r.status_code == 422
    assert r.json() == {"detail": "Activa el módulo de llamadas para agregar teléfonos."}
    assert db.execute("SELECT COUNT(*) FROM phones").fetchone()[0] == 0
