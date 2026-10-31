import os


def test_list_has_four(client, db):
    r = client.get("/api/outputs")
    assert r.status_code == 200 and len(r.json()) == 4


def test_update(client, db):
    r = client.put("/api/outputs/2", json={"duration_ms": 1500, "reader_mask": 1, "enabled": False})
    assert r.status_code == 200
    assert r.json() == {"output_id": 2, "duration_ms": 1500, "reader_mask": 1, "enabled": False,
                        "alias": ""}
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


def _fake_daemon(response=None, error=None, calls=None):
    def request(path, payload, timeout=7.0):
        if calls is not None:
            calls.append((path, dict(payload)))
        if error is not None:
            raise error
        return response
    return request


def test_probar_salida_ok(app, client, db, settings):
    calls = []
    app.state.daemon_request = _fake_daemon({"ok": True}, calls=calls)
    r = client.post("/api/outputs/1/test")
    assert r.status_code == 200 and r.json() == {"detail": "Salida activada"}
    assert calls == [(settings.daemon_socket,
                      {"op": "test_output", "output": 1, "requested_by": "web local"})]


def test_probar_salida_daemon_caido_503(app, client, db):
    from acceso.daemon_socket import DaemonUnavailable
    app.state.daemon_request = _fake_daemon(error=DaemonUnavailable("El daemon no responde"))
    r = client.post("/api/outputs/0/test")
    assert r.status_code == 503 and r.json() == {"detail": "El daemon no responde"}


def test_probar_salida_sin_daemon_real_503(client, db, settings, tmp_path):
    # Sin app.state.daemon_request se usa request_daemon real contra un socket que no existe.
    # Nunca el socket por omisión: en la placa, con el daemon corriendo, activaría Relay1.
    assert settings.daemon_socket == str(tmp_path / "sin-daemon.sock")
    assert not os.path.exists(settings.daemon_socket)
    r = client.post("/api/outputs/0/test")
    assert r.status_code == 503 and r.json() == {"detail": "El daemon no responde"}


def test_probar_salida_ocupada_409(app, client, db):
    app.state.daemon_request = _fake_daemon({"ok": False, "detail": "La salida ya se está probando"})
    r = client.post("/api/outputs/2/test")
    assert r.status_code == 409 and r.json() == {"detail": "La salida ya se está probando"}


def test_probar_salida_inexistente_404(app, client, db):
    calls = []
    app.state.daemon_request = _fake_daemon({"ok": True}, calls=calls)
    r = client.post("/api/outputs/4/test")
    # output_id es base 0; el mensaje usa la numeración visible (base 1), igual que output_test.py.
    assert r.status_code == 404 and r.json() == {"detail": "La salida 5 no existe."}
    assert calls == []


def test_probar_sin_sesion_401(anon_client):
    assert anon_client.post("/api/outputs/0/test").status_code == 401
