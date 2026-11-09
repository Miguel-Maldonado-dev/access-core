import pytest
from helpers import add_holder

BUTTONS = [
    {"rf_code": 10387716, "output_id": 0},
    {"rf_code": 10387714, "output_id": 1},
    {"rf_code": None, "output_id": None},
    {"rf_code": None, "output_id": 2},
]
EMPTY = {"rf_code": None, "output_id": None}


def _post(client, holder_id, buttons=BUTTONS, description="Control 1"):
    return client.post(
        "/api/controls",
        json={"holder_id": holder_id, "description": description, "buttons": buttons},
    )


def test_create_returns_four_buttons(client, db):
    h = add_holder(db)
    r = _post(client, h)
    assert r.status_code == 201
    data = r.json()
    assert data["holder_name"] == "Amadeo 1260"
    assert data["buttons"] == [BUTTONS[0], BUTTONS[1], EMPTY, EMPTY]


def test_wrong_button_count_422(client, db):
    h = add_holder(db)
    assert _post(client, h, BUTTONS[:3]).status_code == 422
    assert _post(client, h, BUTTONS + [EMPTY]).status_code == 422


def test_duplicate_code_in_control_422(client, db):
    h = add_holder(db)
    b = [{"rf_code": 5, "output_id": 0}, {"rf_code": 5, "output_id": 1}, EMPTY, EMPTY]
    r = _post(client, h, b)
    assert r.status_code == 422
    assert r.json()["detail"] == "Cada botón del control debe tener un código distinto."


def test_code_used_by_other_control_409(client, db):
    h = add_holder(db)
    assert _post(client, h).status_code == 201
    b = [{"rf_code": 10387716, "output_id": 0}, EMPTY, EMPTY, EMPTY]
    r = _post(client, h, b)
    assert r.status_code == 409
    assert r.json()["detail"] == "El código 10387716 ya está registrado en el control 1 (Amadeo 1260)."
    assert len(client.get("/api/controls").json()) == 1


def test_bad_output_and_code_422(client, db):
    h = add_holder(db)
    assert _post(client, h, [{"rf_code": 1, "output_id": 4}, EMPTY, EMPTY, EMPTY]).status_code == 422
    assert _post(client, h, [{"rf_code": 4294967296, "output_id": 0}, EMPTY, EMPTY, EMPTY]).status_code == 422
    assert _post(client, h, [{"rf_code": -1, "output_id": 0}, EMPTY, EMPTY, EMPTY]).status_code == 422


def test_unknown_holder_422(client, db):
    r = _post(client, 99)
    assert r.status_code == 422 and r.json()["detail"] == "El titular 99 no existe."


def test_update_same_codes_no_self_conflict(client, db):
    h = add_holder(db)
    h2 = add_holder(db, name="Ana", kind="persona")
    cid = _post(client, h).json()["control_id"]
    r = client.put(
        f"/api/controls/{cid}",
        json={"holder_id": h2, "description": "Otro", "buttons": BUTTONS},
    )
    assert r.status_code == 200
    assert r.json()["holder_name"] == "Ana" and r.json()["description"] == "Otro"
    assert r.json()["buttons"] == [BUTTONS[0], BUTTONS[1], EMPTY, EMPTY]
    r = client.put(
        f"/api/controls/{cid}",
        json={"holder_id": h, "description": "", "buttons": [EMPTY, EMPTY, EMPTY, EMPTY]},
    )
    assert r.status_code == 200 and r.json()["buttons"] == [EMPTY] * 4


def test_update_conflict_and_missing(client, db):
    h = add_holder(db)
    _post(client, h)
    other = _post(client, h, [{"rf_code": 77, "output_id": None}, EMPTY, EMPTY, EMPTY]).json()["control_id"]
    r = client.put(
        f"/api/controls/{other}",
        json={"holder_id": h, "description": "", "buttons": [BUTTONS[0], EMPTY, EMPTY, EMPTY]},
    )
    assert r.status_code == 409
    assert client.put(
        "/api/controls/99", json={"holder_id": h, "description": "", "buttons": [EMPTY] * 4}
    ).status_code == 404


def test_delete_and_list(client, db):
    h = add_holder(db)
    h2 = add_holder(db, name="Ana", kind="persona")
    cid = _post(client, h).json()["control_id"]
    _post(client, h2, [{"rf_code": 9, "output_id": 3}, EMPTY, EMPTY, EMPTY])
    listed = client.get("/api/controls").json()
    assert {c["holder_name"] for c in listed} == {"Amadeo 1260", "Ana"}
    only = client.get("/api/controls", params={"holder_id": h2}).json()
    assert len(only) == 1 and only[0]["holder_kind"] == "persona"
    assert client.delete(f"/api/controls/{cid}").status_code == 204
    assert client.delete(f"/api/controls/{cid}").status_code == 404
    assert db.execute("SELECT COUNT(*) FROM control_buttons WHERE control_id=?", (cid,)).fetchone()[0] == 0


def test_requires_session(anon_client):
    assert anon_client.get("/api/controls").status_code == 401
    assert anon_client.post("/api/controls", json={}).status_code == 401
    assert anon_client.delete("/api/controls/1").status_code == 401


def test_codeless_button_ignores_output(client, db):
    h = add_holder(db)
    b = [{"rf_code": 5, "output_id": 0}, {"rf_code": None, "output_id": 7}, EMPTY, EMPTY]
    r = _post(client, h, b)
    assert r.status_code == 201
    assert r.json()["buttons"] == [b[0], EMPTY, EMPTY, EMPTY]
    cid = r.json()["control_id"]
    r = client.put(f"/api/controls/{cid}", json={"holder_id": h, "description": "", "buttons": b})
    assert r.status_code == 200 and r.json()["buttons"][1] == EMPTY


def test_coded_button_output_4_422_and_count_message(client, db):
    h = add_holder(db)
    r = _post(client, h, [{"rf_code": 1, "output_id": 4}, EMPTY, EMPTY, EMPTY])
    assert r.status_code == 422
    assert r.json()["detail"] == "La salida debe estar entre 0 y 3."
    r = _post(client, h, BUTTONS[:3])
    assert r.json()["detail"] == "El control debe tener exactamente 4 botones."


def _fake_daemon(response=None, error=None, calls=None):
    def request(path, payload, timeout=7.0):
        if calls is not None:
            calls.append((path, dict(payload), timeout))
        if error is not None:
            raise error
        return response
    return request


def test_listen_route_ok(app, client, settings):
    calls = []
    reply = {"ok": True, "code": 99, "control": {"control_id": 3, "description": "Casa"}}
    app.state.daemon_request = _fake_daemon(reply, calls=calls)
    r = client.post("/api/controls/listen")
    assert r.status_code == 200
    assert r.json() == {"code": 99, "control": {"control_id": 3, "description": "Casa"}}
    assert calls == [(settings.daemon_socket, {"op": "listen_rf"}, 13.0)]


def test_listen_route_no_code(app, client):
    app.state.daemon_request = _fake_daemon({"ok": False, "detail": "No se recibió ningún control."})
    r = client.post("/api/controls/listen")
    assert r.status_code == 200 and r.json() == {"code": None, "control": None}


def test_listen_route_busy_409(app, client):
    app.state.daemon_request = _fake_daemon({"ok": False, "detail": "Ya hay una escucha en curso."})
    r = client.post("/api/controls/listen")
    assert r.status_code == 409 and r.json()["detail"] == "Ya hay una escucha en curso."


def test_listen_route_daemon_down_503(app, client):
    from acceso.daemon_socket import DaemonUnavailable
    app.state.daemon_request = _fake_daemon(error=DaemonUnavailable("x"))
    r = client.post("/api/controls/listen")
    assert r.status_code == 503 and r.json()["detail"] == "El daemon no responde"


def test_listen_route_unexpected_detail_503(app, client):
    app.state.daemon_request = _fake_daemon({"ok": False, "detail": "Fallo raro del daemon."})
    r = client.post("/api/controls/listen")
    assert r.status_code == 503 and r.json()["detail"] == "Fallo raro del daemon."


@pytest.mark.parametrize("code", [True, -1, 4294967296, "7", None])
def test_listen_route_invalid_code_503(app, client, code):
    app.state.daemon_request = _fake_daemon({"ok": True, "code": code, "control": None})
    r = client.post("/api/controls/listen")
    assert r.status_code == 503 and r.json()["detail"] == "Código RF inválido"


def test_listen_route_requires_session(anon_client):
    assert anon_client.post("/api/controls/listen").status_code == 401
