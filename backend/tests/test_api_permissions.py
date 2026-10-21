import pytest
PERM = {"permission_id": 3, "name": "Noches", "output_mask": 3, "reader_mask": 15,
        "weekday_mask": 127, "start_minute": 0, "end_minute": 1439, "allow_pin": False}


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


def test_allow_pin_roundtrip_and_default(client, db):
    assert client.get("/api/permissions").json()[0]["allow_pin"] is False
    r = client.post("/api/permissions", json={**PERM, "allow_pin": True})
    assert r.status_code == 201 and r.json()["allow_pin"] is True
    body = {k: v for k, v in PERM.items() if k != "permission_id"}
    assert client.put("/api/permissions/3", json={**body, "allow_pin": False}).json()["allow_pin"] is False
    no_flag = {k: v for k, v in body.items() if k != "allow_pin"}
    assert client.put("/api/permissions/3", json=no_flag).json()["allow_pin"] is False
    assert client.put("/api/permissions/3", json={**body, "allow_pin": True}).json()["allow_pin"] is True
    assert [p["allow_pin"] for p in client.get("/api/permissions").json()] == [False, True]


def test_put_without_allow_pin_keeps_it(client, db):
    client.post("/api/permissions", json={**PERM, "allow_pin": True})
    body = {k: v for k, v in PERM.items() if k not in ("permission_id", "allow_pin")}
    r = client.put("/api/permissions/3", json={**body, "name": "Otro"})
    assert r.status_code == 200 and r.json()["allow_pin"] is True and r.json()["name"] == "Otro"


@pytest.mark.parametrize("value", ["yes", "on", 1, "true"])
def test_allow_pin_is_strict_bool(client, db, value):
    assert client.post("/api/permissions", json={**PERM, "allow_pin": value}).status_code == 422
