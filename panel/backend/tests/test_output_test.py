from datetime import datetime

import pytest
from helpers import NOW, add_holder, set_permission

from acceso.output_test import OutputTester, RelayLink
from acceso.protocol import build_relay_command


class Sender:
    def __init__(self):
        self.sent = []

    def __call__(self, frame):
        self.sent.append(frame)


class FakeClock:
    def __init__(self, now=100.0):
        self.now = now

    def __call__(self):
        return self.now


@pytest.fixture
def sender():
    return Sender()


@pytest.fixture
def relay(sender):
    link = RelayLink()
    link.set(sender)
    return link


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def tester(conn, tmp_path, relay, clock):
    # `conn` (conftest) crea el esquema en tmp_path/test.sqlite; el probador abre la suya.
    return OutputTester(tmp_path / "test.sqlite", relay, max_entries=1000, clock=clock,
                        wall=lambda: 1700000000.7, now=lambda: local_now[0])


# Hora local que ve `remote_open` (el reloj falso se inyecta como `now` en access.py).
local_now = [NOW]


@pytest.fixture(autouse=True)
def reset_local_now():
    local_now[0] = NOW
    yield
    local_now[0] = NOW


def request(output=1, requested_by="web local", op="test_output"):
    return {"op": op, "output": output, "requested_by": requested_by}


def last_log(conn):
    return conn.execute("SELECT * FROM access_logs ORDER BY log_id DESC LIMIT 1").fetchone()


def test_activa_con_duracion_configurada(tester, sender):
    assert tester.handle(request(1)) == {"ok": True}
    assert sender.sent == [build_relay_command(1, 3000)]


def test_usa_la_duracion_guardada(conn, tester, sender):
    conn.execute("UPDATE outputs SET duration_ms = 1500 WHERE output_id = 2")
    assert tester.handle(request(2)) == {"ok": True}
    assert sender.sent == [build_relay_command(2, 1500)]


def test_registra_log_prueba(conn, tester):
    tester.handle(request(1))
    row = last_log(conn)
    assert (row["source"], row["allowed"], row["reason"]) == (5, 1, 0)
    assert row["credential_label"] == "Prueba — web local"
    assert row["output_id"] == 1
    assert row["holder_id"] is None and row["code"] is None
    assert row["timestamp"] == 1700000000


def test_salida_deshabilitada_tambien_se_prueba(conn, tester, sender):
    conn.execute("UPDATE outputs SET enabled = 0 WHERE output_id = 3")
    assert tester.handle(request(3)) == {"ok": True}
    assert sender.sent == [build_relay_command(3, 3000)]


def test_segunda_prueba_dentro_de_la_duracion_se_rechaza(conn, tester, sender, clock):
    assert tester.handle(request(1)) == {"ok": True}
    clock.now += 2.9
    assert tester.handle(request(1)) == {"ok": False, "detail": "La salida ya está en uso"}
    assert len(sender.sent) == 1
    assert conn.execute("SELECT COUNT(*) FROM access_logs").fetchone()[0] == 1
    # Otra salida no está ocupada.
    assert tester.handle(request(0)) == {"ok": True}
    clock.now += 0.2
    assert tester.handle(request(1)) == {"ok": True}
    assert len(sender.sent) == 3


def test_sin_puerto_registra_error_uart(conn, tester, relay, sender):
    relay.set(None)
    reply = tester.handle(request(1))
    assert reply == {"ok": False, "detail": "No se pudo enviar la orden al relevador."}
    row = last_log(conn)
    assert (row["source"], row["allowed"], row["reason"], row["output_id"]) == (5, 0, 4, 1)
    assert sender.sent == []
    # Un envío fallido no deja la salida ocupada.
    relay.set(sender)
    assert tester.handle(request(1)) == {"ok": True}


def test_error_de_escritura_registra_error_uart(conn, tester, relay):
    def broken(frame):
        raise OSError("Error al escribir en el puerto serie")

    relay.set(broken)
    assert tester.handle(request(0))["ok"] is False
    assert last_log(conn)["reason"] == 4


@pytest.mark.parametrize("bad", [
    request(output=7),
    request(output=-1),
    request(output=True),
    request(output="1"),
    request(requested_by="web\nlocal"),
    request(requested_by=""),
    request(requested_by="x" * 121),
    request(requested_by=5),
    request(op="abrir"),
    {"op": "test_output", "output": 1},
])
def test_peticion_invalida(conn, tester, sender, bad):
    assert tester.handle(bad) == {"ok": False, "detail": "Petición inválida."}
    assert sender.sent == []
    assert conn.execute("SELECT COUNT(*) FROM access_logs").fetchone()[0] == 0


def test_requested_by_de_120_caracteres_se_acepta(tester):
    assert tester.handle(request(requested_by="x" * 120)) == {"ok": True}


def test_relay_link_sin_send_lanza_oserror():
    link = RelayLink()
    with pytest.raises(OSError, match="Puerto serie no disponible"):
        link.send(b"\x00")


def test_salida_inexistente(conn, tester, sender):
    conn.execute("DELETE FROM outputs WHERE output_id = 2")
    assert tester.handle(request(2)) == {"ok": False, "detail": "La salida 3 no existe."}
    assert sender.sent == []
    assert conn.execute("SELECT COUNT(*) FROM access_logs").fetchone()[0] == 0


# --- remote_open ---

def remote_holder(conn, name="Ana", allow_remote=1, allow_rf=0, output_mask=0b0010, **kw):
    set_permission(conn, 0, output_mask=output_mask, allow_rf=allow_rf,
                   allow_remote=allow_remote, **kw)
    holder_id = add_holder(conn, name=name, kind="persona")
    holder_uuid = conn.execute("SELECT uuid FROM holders WHERE holder_id = ?",
                               (holder_id,)).fetchone()[0]
    return holder_id, holder_uuid


def remote(holder_uuid, output=1, requested_by="Admin Nube"):
    return {"op": "remote_open", "output": output, "holder_uuid": holder_uuid,
            "requested_by": requested_by}


def log_count(conn):
    return conn.execute("SELECT COUNT(*) FROM access_logs").fetchone()[0]


def test_remote_open_con_permiso_abre(conn, tester, sender):
    conn.execute("UPDATE outputs SET duration_ms = 1500 WHERE output_id = 1")
    holder_id, holder_uuid = remote_holder(conn)
    assert tester.handle(remote(holder_uuid)) == {"ok": True, "reason": 0,
                                                 "detail": "Salida abierta"}
    assert sender.sent == [build_relay_command(1, 1500)]
    row = last_log(conn)
    assert (row["source"], row["allowed"], row["reason"]) == (4, 1, 0)
    assert (row["holder_id"], row["holder_name"], row["holder_kind"]) == (holder_id, "Ana",
                                                                          "persona")
    assert row["credential_label"] == "Admin Nube"
    assert row["output_id"] == 1
    assert row["timestamp"] == 1700000000
    assert row["code"] is None and row["device_id"] is None


def test_remote_open_sin_allow_remote_rechaza_motivo_3(conn, tester, sender):
    holder_id, holder_uuid = remote_holder(conn, allow_rf=1, allow_remote=0)
    assert tester.handle(remote(holder_uuid)) == {
        "ok": False, "reason": 3, "detail": "Sin permiso de apertura remota"}
    assert sender.sent == []
    row = last_log(conn)
    assert (row["source"], row["allowed"], row["reason"]) == (4, 0, 3)
    assert row["holder_id"] == holder_id and row["output_id"] == 1
    assert row["credential_label"] == "Admin Nube"


def test_remote_open_titular_sin_permisos_asignados_motivo_3(conn, tester, sender):
    # El permiso 0 permitiría la apertura remota, pero el titular no tiene ninguno asignado.
    set_permission(conn, 0, output_mask=0b0010, allow_remote=1)
    holder_id = add_holder(conn, name="Sin permisos", kind="persona", permission_ids=())
    holder_uuid = conn.execute("SELECT uuid FROM holders WHERE holder_id = ?",
                               (holder_id,)).fetchone()[0]
    assert tester.handle(remote(holder_uuid)) == {
        "ok": False, "reason": 3, "detail": "Sin permiso de apertura remota"}
    assert sender.sent == []
    row = last_log(conn)
    assert (row["source"], row["allowed"], row["reason"]) == (4, 0, 3)
    assert row["holder_id"] == holder_id


def test_remote_open_salida_fuera_de_output_mask_rechaza(conn, tester, sender):
    _, holder_uuid = remote_holder(conn, output_mask=0b0001)
    assert tester.handle(remote(holder_uuid, output=1))["reason"] == 3
    assert sender.sent == []


@pytest.mark.parametrize("start, end, now, expected", [
    (480, 1080, NOW, 0),
    (480, 1080, NOW.replace(hour=20), 3),
    (1320, 360, NOW.replace(hour=23, minute=30), 0),
    (1320, 360, NOW.replace(hour=5, minute=59), 0),
    (1320, 360, NOW.replace(hour=6), 3),
    (1320, 360, NOW.replace(hour=12), 3),
])
def test_remote_open_fuera_de_horario_rechaza(conn, tester, sender, start, end, now, expected):
    _, holder_uuid = remote_holder(conn, start_minute=start, end_minute=end)
    local_now[0] = now
    reply = tester.handle(remote(holder_uuid))
    assert reply["reason"] == expected and reply["ok"] is (expected == 0)
    assert len(sender.sent) == (1 if expected == 0 else 0)
    assert (last_log(conn)["source"], last_log(conn)["reason"]) == (4, expected)


def test_remote_open_fuera_de_dia_rechaza(conn, tester, sender):
    _, holder_uuid = remote_holder(conn, weekday_mask=0b0011111)  # lunes a viernes
    local_now[0] = datetime(2026, 10, 4, 10)  # domingo
    assert tester.handle(remote(holder_uuid))["reason"] == 3
    assert sender.sent == []


def test_remote_open_titular_desconocido_motivo_11(conn, tester, sender):
    remote_holder(conn)
    unknown = "0b7e5c1a-3f2d-4c8e-9a1b-2c3d4e5f6a7b"
    assert tester.handle(remote(unknown)) == {"ok": False, "reason": 11,
                                             "detail": "Titular desconocido"}
    assert sender.sent == []
    row = last_log(conn)
    assert (row["source"], row["allowed"], row["reason"]) == (4, 0, 11)
    assert row["holder_id"] is None and row["holder_name"] is None
    assert row["credential_label"] == "Admin Nube"
    assert row["output_id"] == 1


def test_remote_open_salida_deshabilitada_motivo_2(conn, tester, sender):
    conn.execute("UPDATE outputs SET enabled = 0 WHERE output_id = 1")
    holder_id, holder_uuid = remote_holder(conn)
    assert tester.handle(remote(holder_uuid)) == {
        "ok": False, "reason": 2, "detail": "La salida no existe o está deshabilitada"}
    assert sender.sent == []
    row = last_log(conn)
    assert (row["source"], row["allowed"], row["reason"]) == (4, 0, 2)
    assert row["holder_id"] == holder_id and row["output_id"] == 1
    # "Probar" sí activa la salida deshabilitada.
    assert tester.handle(request(1)) == {"ok": True}
    assert sender.sent == [build_relay_command(1, 3000)]


def test_remote_open_salida_inexistente_motivo_2(conn, tester, sender):
    conn.execute("DELETE FROM outputs WHERE output_id = 1")
    _, holder_uuid = remote_holder(conn)
    assert tester.handle(remote(holder_uuid))["reason"] == 2
    assert sender.sent == []


def test_remote_open_ocupada(conn, tester, sender, clock):
    _, holder_uuid = remote_holder(conn)
    assert tester.handle(remote(holder_uuid))["ok"] is True
    clock.now += 2.9
    assert tester.handle(remote(holder_uuid)) == {"ok": False, "reason": 0,
                                                 "detail": "La salida ya está en uso"}
    assert len(sender.sent) == 1
    assert log_count(conn) == 1
    clock.now += 0.2
    assert tester.handle(remote(holder_uuid))["ok"] is True
    assert len(sender.sent) == 2


def test_remote_open_ocupada_por_una_prueba(conn, tester, sender):
    _, holder_uuid = remote_holder(conn)
    assert tester.handle(request(1)) == {"ok": True}
    assert tester.handle(remote(holder_uuid))["detail"] == "La salida ya está en uso"
    assert len(sender.sent) == 1


def test_remote_open_sin_puerto_motivo_4(conn, tester, relay, sender):
    holder_id, holder_uuid = remote_holder(conn)
    relay.set(None)
    assert tester.handle(remote(holder_uuid)) == {
        "ok": False, "reason": 4, "detail": "No se pudo enviar la orden al relevador."}
    row = last_log(conn)
    assert (row["source"], row["allowed"], row["reason"]) == (4, 0, 4)
    assert row["holder_id"] == holder_id
    # Un envío fallido no deja la salida ocupada.
    relay.set(sender)
    assert tester.handle(remote(holder_uuid))["ok"] is True


VALID_UUID = "0b7e5c1a-3f2d-4c8e-9a1b-2c3d4e5f6a7b"


@pytest.mark.parametrize("bad", [
    remote(VALID_UUID.upper()),
    remote("0b7e5c1a3f2d4c8e9a1b2c3d4e5f6a7b"),
    remote("{0b7e5c1a-3f2d-4c8e-9a1b-2c3d4e5f6a7b}"),
    remote(VALID_UUID + "\n"),
    remote(""),
    remote(5),
    remote(None),
    remote(VALID_UUID, output=True),
    remote(VALID_UUID, output=4),
    remote(VALID_UUID, output=-1),
    remote(VALID_UUID, output="1"),
    remote(VALID_UUID, requested_by=""),
    remote(VALID_UUID, requested_by="x" * 121),
    remote(VALID_UUID, requested_by="a\tb"),
    remote(VALID_UUID, requested_by=7),
    {"op": "remote_open", "output": 1, "requested_by": "Admin"},
    {"op": "abrir_remoto", "output": 1, "holder_uuid": VALID_UUID, "requested_by": "Admin"},
    {"output": 1, "holder_uuid": VALID_UUID, "requested_by": "Admin"},
])
def test_remote_open_peticion_invalida(conn, tester, sender, bad):
    remote_holder(conn)
    assert tester.handle(bad) == {"ok": False, "detail": "Petición inválida."}
    assert sender.sent == []
    assert log_count(conn) == 0


def test_remote_open_requested_by_de_120_caracteres_se_acepta(conn, tester):
    _, holder_uuid = remote_holder(conn)
    assert tester.handle(remote(holder_uuid, requested_by="x" * 120))["ok"] is True
    assert last_log(conn)["credential_label"] == "x" * 120
