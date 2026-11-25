from acceso.daemon_socket import DaemonUnavailable
from helpers import add_holder

BODY = {"enabled": True, "mode": "menu", "output_id": 0, "menu_mask": 5, "default_output": 2,
        "call_limit_per_minute": 3}


def test_settings_defaults_and_roundtrip(client, db):
    assert client.get("/api/calls/settings").json() == {
        "enabled": False, "mode": "single", "output_id": 0, "menu_mask": 0,
        "default_output": None, "call_limit_per_minute": 3}
    r = client.put("/api/calls/settings", json=BODY)
    assert r.status_code == 200 and r.json() == BODY
    assert client.get("/api/calls/settings").json() == BODY


def test_settings_default_output_outside_menu_422(client, db):
    r = client.put("/api/calls/settings", json={**BODY, "default_output": 1})
    assert r.status_code == 422
    assert r.json() == {"detail": "La salida predeterminada debe estar entre las salidas del menú."}


def test_settings_bad_mode_and_output_422(client, db):
    assert client.put("/api/calls/settings", json={**BODY, "mode": "otro"}).status_code == 422
    assert client.put("/api/calls/settings", json={**BODY, "output_id": 4}).status_code == 422
    assert client.put("/api/calls/settings", json={**BODY, "menu_mask": 16}).status_code == 422


def test_settings_limit_range(client, db):
    for bad in (0, 21):
        r = client.put("/api/calls/settings", json={**BODY, "call_limit_per_minute": bad})
        assert r.status_code == 422 and r.json() == {"detail": "Debe ser un número entre 1 y 20."}
    for good in (1, 20):
        r = client.put("/api/calls/settings", json={**BODY, "call_limit_per_minute": good})
        assert r.status_code == 200 and r.json()["call_limit_per_minute"] == good


def test_disable_module_deletes_phones_without_outbox(client, db):
    h = add_holder(db)
    client.put("/api/calls/settings", json=BODY)
    client.post("/api/phones", json={"holder_id": h, "number": "5512345678", "description": ""})
    db.execute("DELETE FROM sync_outbox")
    r = client.put("/api/calls/settings", json={**BODY, "enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False
    assert client.get("/api/phones").json() == []
    outbox = [tuple(x) for x in db.execute("SELECT table_name, op FROM sync_outbox")]
    assert outbox == [("call_settings", "upsert")]
    assert db.execute("SELECT applying FROM sync_guard").fetchone()[0] == 0


def test_status_ok_and_daemon_down_503(app, client, db):
    reply = {"ok": True, "enabled": True, "port": "/dev/x", "connected": True,
             "registered": True, "signal": 20}
    calls = []

    def ok(path, payload, timeout=7.0):
        calls.append(payload)
        return reply
    app.state.daemon_request = ok
    assert client.get("/api/calls/status").json() == reply and calls == [{"op": "gsm_status"}]

    def down(path, payload, timeout=7.0):
        raise DaemonUnavailable("El daemon no responde")
    app.state.daemon_request = down
    r = client.get("/api/calls/status")
    assert r.status_code == 503 and r.json() == {"detail": "El daemon no responde"}


def test_requires_session(anon_client):
    assert anon_client.get("/api/calls/settings").status_code == 401
    assert anon_client.get("/api/calls/status").status_code == 401


def test_settings_without_limit_keeps_current(client, db):
    db.execute("UPDATE call_settings SET call_limit_per_minute = 7 WHERE id = 1")
    db.commit()
    r = client.put("/api/calls/settings", json={"enabled": True, "mode": "single", "output_id": 1,
                                                "menu_mask": 0, "default_output": None})
    assert r.status_code == 200 and r.json()["call_limit_per_minute"] == 7 and r.json()["output_id"] == 1
