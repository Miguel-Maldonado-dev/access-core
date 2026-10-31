import pytest

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
                        wall=lambda: 1700000000.7)


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
    assert tester.handle(request(1)) == {"ok": False, "detail": "La salida ya se está probando"}
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
