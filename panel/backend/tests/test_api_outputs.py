def test_list_has_four(client, db):
    r = client.get("/api/outputs")
    assert r.status_code == 200 and len(r.json()) == 4


def test_update(client, db):
    r = client.put("/api/outputs/2", json={"duration_ms": 1500, "reader_mask": 1, "enabled": False})
    assert r.status_code == 200
    assert r.json() == {"output_id": 2, "duration_ms": 1500, "reader_mask": 1, "enabled": False}
    assert client.get("/api/outputs").json()[2]["enabled"] is False


def test_missing_output_404(client, db):
    r = client.put("/api/outputs/4", json={"duration_ms": 1, "reader_mask": 1, "enabled": True})
    assert r.status_code == 404 and r.json()["detail"] == "La salida 4 no existe."


def test_duration_too_big_422(client, db):
    r = client.put("/api/outputs/1", json={"duration_ms": 70000, "reader_mask": 1, "enabled": True})
    assert r.status_code == 422


def test_requires_session(anon_client):
    assert anon_client.get("/api/outputs").status_code == 401
    assert anon_client.put("/api/outputs/1", json={}).status_code == 401
