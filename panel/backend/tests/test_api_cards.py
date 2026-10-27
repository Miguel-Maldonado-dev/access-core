from helpers import add_holder


def _post(client, code=8518512, holder_id=None, description="Tarjeta de Juan"):
    return client.post(
        "/api/cards",
        json={"card_code": code, "holder_id": holder_id, "description": description},
    )


def test_create_and_duplicate(client, db):
    h = add_holder(db)
    r = _post(client, holder_id=h)
    assert r.status_code == 201
    assert r.json()["holder_name"] == "Amadeo 1260"
    assert r.json()["card_code"] == 8518512
    r = _post(client, holder_id=h)
    assert r.status_code == 409
    assert r.json()["detail"] == "La tarjeta 8518512 ya está registrada a Amadeo 1260."


def test_unknown_holder_422(client, db):
    r = _post(client, holder_id=99)
    assert r.status_code == 422
    assert r.json()["detail"] == "El titular 99 no existe."


def test_code_out_of_range_422(client, db):
    h = add_holder(db)
    assert _post(client, code=4294967296, holder_id=h).status_code == 422
    assert _post(client, code=-1, holder_id=h).status_code == 422
    assert _post(client, code=4294967295, holder_id=h).status_code == 201
    assert _post(client, code=0, holder_id=h).status_code == 201


def test_update_changes_holder_and_description(client, db):
    h1 = add_holder(db)
    h2 = add_holder(db, name="Ana", kind="persona")
    _post(client, holder_id=h1)
    r = client.put("/api/cards/8518512", json={"holder_id": h2, "description": "Nueva"})
    assert r.status_code == 200
    assert r.json()["holder_name"] == "Ana" and r.json()["description"] == "Nueva"
    assert client.put("/api/cards/8518512", json={"holder_id": 99, "description": ""}).status_code == 422
    assert client.put("/api/cards/1", json={"holder_id": h2, "description": ""}).status_code == 404


def test_list_filter_by_holder(client, db):
    h1 = add_holder(db)
    h2 = add_holder(db, name="Ana", kind="persona")
    _post(client, code=1, holder_id=h1)
    _post(client, code=2, holder_id=h2)
    assert len(client.get("/api/cards").json()) == 2
    found = client.get("/api/cards", params={"holder_id": h2}).json()
    assert [c["card_code"] for c in found] == [2]
    assert found[0]["holder_kind"] == "persona" and found[0]["holder_name"] == "Ana"


def test_delete(client, db):
    h = add_holder(db)
    _post(client, holder_id=h)
    assert client.delete("/api/cards/8518512").status_code == 204
    assert client.delete("/api/cards/8518512").status_code == 404
    assert client.get("/api/cards").json() == []


def test_requires_session(anon_client):
    assert anon_client.get("/api/cards").status_code == 401
    assert anon_client.post("/api/cards", json={}).status_code == 401
    assert anon_client.delete("/api/cards/1").status_code == 401
