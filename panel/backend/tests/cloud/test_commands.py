"""Órdenes de la nube para el agente: `CommandWorker` (prueba de salida) y `post_command_result`.

El daemon y la nube son falsos: nunca se abre un socket real ni se llama a la red.
"""
import logging
import threading
import time
import uuid

import pytest
from fake_cloud import FakeCloud

from acceso.cloud.commands import DETAIL_MAX, QUEUE_MAX, CommandWorker
from acceso.daemon_socket import DaemonUnavailable

SOCKET = "/run/acceso/daemon.sock"
NOW = 1_800_000_000.0           # 2027-01-15T08:00:00Z
VALID_UNTIL = "2027-01-15T08:00:10.000Z"   # NOW + 10 s
EXPIRED_AT = "2027-01-15T07:59:59.000Z"    # NOW - 1 s


class FakeDaemon:
    def __init__(self, reply=None, error=None):
        self.reply = {"ok": True} if reply is None else reply
        self.error = error
        self.requests = []

    def __call__(self, path, payload):
        self.requests.append((path, dict(payload)))
        if self.error is not None:
            raise self.error
        return self.reply


class Results:
    """`post_result` falso; `error` hace que falle como lo haría la nube caída."""

    def __init__(self, error=None):
        self.items = []
        self.error = error
        self.done = threading.Event()

    def __call__(self, command_id, ok, detail):
        self.items.append((command_id, ok, detail))
        self.done.set()
        if self.error is not None:
            raise self.error


def order(**changes):
    body = {"type": "test_output", "command_id": str(uuid.uuid4()), "output": 1,
            "requested_by": "ana@example.com", "expires_at": VALID_UNTIL}
    body.update(changes)
    return body


def run(daemon, results, *bodies):
    """Corre el worker real (con su hilo) hasta que atiende todas las órdenes."""
    worker = CommandWorker(daemon, SOCKET, results, wall=lambda: NOW)
    worker.start()
    thread = worker._thread
    for body in bodies:
        worker.submit(body)
    # stop() descarta lo pendiente: para esperar a que se atienda todo, el centinela va al final
    # de la cola y se espera al hilo sin plazo.
    worker._queue.put(None)
    thread.join()
    worker.stop()
    return worker


def test_orden_valida_llama_al_daemon_e_informa():
    daemon, results = FakeDaemon(), Results()
    body = order(output=2)
    run(daemon, results, body)
    assert daemon.requests == [(SOCKET, {"op": "test_output", "output": 2,
                                         "requested_by": "ana@example.com"})]
    assert results.items == [(body["command_id"], True, None)]


def test_el_error_del_daemon_se_informa_con_su_detalle():
    daemon = FakeDaemon(reply={"ok": False, "detail": "La salida ya se está probando"})
    results = Results()
    body = order()
    run(daemon, results, body)
    assert results.items == [(body["command_id"], False, "La salida ya se está probando")]


def test_el_detalle_largo_se_recorta_a_200_caracteres():
    # La nube rechaza un detail de más de 200 caracteres: el agente lo recorta antes de informar.
    daemon = FakeDaemon(reply={"ok": False, "detail": "x" * 250})
    results = Results()
    body = order()
    run(daemon, results, body)
    assert DETAIL_MAX == 200
    assert results.items == [(body["command_id"], False, "x" * 200)]


def test_orden_caducada_no_llama_al_daemon(caplog):
    daemon, results = FakeDaemon(), Results()
    with caplog.at_level(logging.INFO, logger="acceso.cloud"):
        run(daemon, results, order(expires_at=EXPIRED_AT))
    assert daemon.requests == [] and results.items == []
    assert "caduc" in caplog.text


def test_orden_que_vence_justo_ahora_aun_se_ejecuta():
    daemon, results = FakeDaemon(), Results()
    run(daemon, results, order(expires_at="2027-01-15T08:00:00Z"))
    assert len(daemon.requests) == 1


def test_command_id_repetido_se_ejecuta_una_vez():
    daemon, results = FakeDaemon(), Results()
    body = order()
    run(daemon, results, body, dict(body), order())
    assert len(daemon.requests) == 2
    assert [item[0] for item in results.items].count(body["command_id"]) == 1


def test_recuerda_solo_los_ultimos_256_command_id():
    daemon, results = FakeDaemon(), Results()
    worker = CommandWorker(daemon, SOCKET, results, wall=lambda: NOW)
    first = order()
    # Sin hilo: más órdenes de las que caben en la cola (QUEUE_MAX), atendidas una por una.
    for body in [first] + [order() for _ in range(255)] + [dict(first)]:
        worker._handle(body)
    assert len(daemon.requests) == 256   # aún lo recuerda: el repetido se descarta
    worker._handle(order())
    worker._handle(dict(first))
    assert len(daemon.requests) == 258   # con 257 vistos el primero ya se olvidó: se vuelve a ejecutar


def test_la_cola_llena_descarta_sin_bloquear(caplog):
    worker = CommandWorker(FakeDaemon(), SOCKET, Results(), wall=lambda: NOW)   # sin start()
    with caplog.at_level(logging.WARNING, logger="acceso.cloud"):
        for _ in range(QUEUE_MAX + 1):
            worker.submit(order())
    assert "Cola de órdenes llena" in caplog.text


def test_daemon_caido_informa_false():
    daemon, results = FakeDaemon(error=DaemonUnavailable("El daemon no responde")), Results()
    body = order()
    run(daemon, results, body)
    assert results.items == [(body["command_id"], False, "El daemon no responde")]


@pytest.mark.parametrize("changes", [
    {"output": "1"},
    {"output": True},
    {"output": 4},
    {"output": -1},
    {"expires_at": "2027-01-15T08:00:10"},          # sin zona horaria
    {"expires_at": "mañana"},
    {"expires_at": None},
    {"command_id": "no-es-un-uuid"},
    {"command_id": 7},
    {"requested_by": ""},
    {"requested_by": "x" * 121},
    {"requested_by": None},
])
def test_campos_invalidos_se_descartan(changes):
    daemon, results = FakeDaemon(), Results()
    run(daemon, results, order(**changes))
    assert daemon.requests == [] and results.items == []


def test_acepta_fechas_con_zona_y_fracciones_de_cualquier_longitud():
    daemon, results = FakeDaemon(), Results()
    run(daemon, results,
        order(expires_at="2027-01-15T02:00:10-06:00"),
        order(expires_at="2027-01-15T08:00:10.5+00:00"),
        order(expires_at="2027-01-15T08:00:10.123456789Z"),
        order(requested_by="x" * 120))
    assert len(daemon.requests) == 4


def test_fallo_al_informar_no_tumba_el_hilo(caplog):
    daemon = FakeDaemon()
    results = Results(error=RuntimeError("detalle con un secreto"))
    with caplog.at_level(logging.WARNING, logger="acceso.cloud"):
        run(daemon, results, order(), order())
    assert len(daemon.requests) == 2 and len(results.items) == 2   # la segunda también se atendió
    assert "RuntimeError" in caplog.text and "secreto" not in caplog.text


def test_un_error_inesperado_del_daemon_no_tumba_el_hilo(caplog):
    daemon = FakeDaemon(error=ValueError("raro"))
    results = Results()
    with caplog.at_level(logging.WARNING, logger="acceso.cloud"):
        run(daemon, results, order(), order())
    assert len(daemon.requests) == 2 and results.items == []
    assert "ValueError" in caplog.text


def test_submit_no_bloquea_y_el_hilo_atiende_en_segundo_plano():
    gate = threading.Event()
    daemon = FakeDaemon()
    results = Results()

    def slow(path, payload):
        gate.wait(5)
        return daemon(path, payload)

    worker = CommandWorker(slow, SOCKET, results, wall=lambda: NOW)
    worker.start()
    worker.submit(order())   # vuelve aunque el daemon siga "ocupado"
    assert results.items == []
    gate.set()
    assert results.done.wait(5)
    worker.stop()


def test_stop_no_bloquea_y_no_llama_mas_al_daemon():
    gate = threading.Event()
    calls = []

    def blocked(path, payload):
        calls.append(payload)
        gate.wait(5)
        return {"ok": True}

    worker = CommandWorker(blocked, SOCKET, Results(), wall=lambda: NOW)
    worker.start()
    thread = worker._thread
    worker.submit(order())
    deadline = time.monotonic() + 5
    while not calls and time.monotonic() < deadline:   # el hilo ya está en el daemon
        time.sleep(0.01)
    for _ in range(QUEUE_MAX):   # y la cola, llena
        worker.submit(order())
    started = time.monotonic()
    worker.stop()
    assert time.monotonic() - started < 0.5
    gate.set()
    thread.join(5)
    assert not thread.is_alive()
    assert len(calls) == 1   # solo la que ya estaba en curso


def test_stop_sin_start_no_falla():
    CommandWorker(FakeDaemon(), SOCKET, Results()).stop()


# --- API: POST /command-result ------------------------------------------------------------------

def test_post_command_result_envia_el_contrato_con_la_credencial():
    cloud = FakeCloud()
    api = cloud.api()
    command_id = str(uuid.uuid4())
    api.post_command_result(command_id, False, "El daemon no responde")
    api.post_command_result(command_id, True, None)
    assert cloud.command_results == [
        {"command_id": command_id, "ok": False, "detail": "El daemon no responde"},
        {"command_id": command_id, "ok": True, "detail": None},
    ]
    assert cloud.paths("POST") == ["/command-result", "/command-result"]
