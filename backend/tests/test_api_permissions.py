import pytest
PERM = {"permission_id": 3, "name": "Noches", "output_mask": 3, "card_reader_mask": 15,
        "pin_reader_mask": 0, "weekday_mask": 127, "start_minute": 0, "end_minute": 1439,
        "allow_rf": False}


def test_create_and_duplicate(client, db):
    r = client.post("/api/permissions", json=PERM)
    assert r.status_code == 201 and r.json()["permission_id"] == 3
    r = client.post("/api/permissions", json=PERM)
    assert r.status_code == 409 and r.json()["detail"] == "Ya existe el permiso 3."
    ids = [p["permission_id"] for p in client.get("/api/permissions").json()]
    assert ids == [0, 3]


def test_out_of_range_422(client, db):
    assert client.post("/api/permissions", json={**PERM, "permission_id": 32}).status_code == 422
    assert client.post("/api/permissions", json={**PERM, "start_minute": 1440}).status_code == 422
    assert client.post("/api/permissions", json={**PERM, "output_mask": 16}).status_code == 422
    assert client.post("/api/permissions", json={**PERM, "weekday_mask": 128}).status_code == 422


def test_update(client, db):
    client.post("/api/permissions", json=PERM)
    body = {k: v for k, v in PERM.items() if k != "permission_id"}
    body.update(name="Otro", output_mask=1)
    r = client.put("/api/permissions/3", json=body)
    assert r.status_code == 200 and r.json()["name"] == "Otro" and r.json()["output_mask"] == 1
    assert client.put("/api/permissions/20", json=body).status_code == 404


def test_delete_removes_from_holder(client, db):
    client.post("/api/permissions", json=PERM)
    hid = client.post("/api/holders", json={"kind": "persona", "name": "Ana", "permission_ids": [0, 3]}).json()["holder_id"]
    assert client.delete("/api/permissions/3").status_code == 204
    assert client.get(f"/api/holders/{hid}").json()["permission_ids"] == [0]
    assert client.delete("/api/permissions/3").status_code == 404


def test_requires_session(anon_client):
    assert anon_client.get("/api/permissions").status_code == 401
    assert anon_client.post("/api/permissions", json=PERM).status_code == 401
    assert anon_client.put("/api/permissions/3", json=PERM).status_code == 401
    assert anon_client.delete("/api/permissions/3").status_code == 401


def test_method_fields_roundtrip_and_default(client, db):
    first = client.get("/api/permissions").json()[0]
    assert (first["card_reader_mask"], first["pin_reader_mask"], first["allow_rf"]) == (15, 0, True)
    assert "reader_mask" not in first and "allow_pin" not in first
    new = {**PERM, "card_reader_mask": 5, "pin_reader_mask": 10, "allow_rf": True}
    r = client.post("/api/permissions", json=new)
    assert r.status_code == 201
    assert (r.json()["card_reader_mask"], r.json()["pin_reader_mask"], r.json()["allow_rf"]) == (5, 10, True)
    body = {k: v for k, v in new.items() if k != "permission_id"}
    r = client.put("/api/permissions/3", json={**body, "card_reader_mask": 0, "pin_reader_mask": 15,
                                               "allow_rf": False})
    assert (r.json()["card_reader_mask"], r.json()["pin_reader_mask"], r.json()["allow_rf"]) == (0, 15, False)


def test_put_without_method_fields_keeps_them(client, db):
    client.post("/api/permissions", json={**PERM, "card_reader_mask": 5, "pin_reader_mask": 10,
                                          "allow_rf": True})
    body = {k: v for k, v in PERM.items()
            if k not in ("permission_id", "card_reader_mask", "pin_reader_mask", "allow_rf")}
    r = client.put("/api/permissions/3", json={**body, "name": "Otro"})
    assert r.status_code == 200 and r.json()["name"] == "Otro"
    assert (r.json()["card_reader_mask"], r.json()["pin_reader_mask"], r.json()["allow_rf"]) == (5, 10, True)
    r = client.put("/api/permissions/3", json={**body, "pin_reader_mask": 1})
    assert (r.json()["card_reader_mask"], r.json()["pin_reader_mask"], r.json()["allow_rf"]) == (5, 1, True)


@pytest.mark.parametrize("field,value", [("allow_rf", "yes"), ("allow_rf", 1), ("allow_rf", "true"),
                                         ("card_reader_mask", 16), ("pin_reader_mask", -1)])
def test_method_fields_validated(client, db, field, value):
    assert client.post("/api/permissions", json={**PERM, field: value}).status_code == 422
