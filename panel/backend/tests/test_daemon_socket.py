import os
import shutil
import socket
import stat
import tempfile

import pytest

from acceso.daemon_socket import DaemonSocketServer, DaemonUnavailable, request_daemon


@pytest.fixture
def sock_path():
    # En macOS la ruta de un socket Unix no puede pasar de ~104 bytes y tmp_path suele pasarse.
    folder = tempfile.mkdtemp(dir="/tmp")
    yield os.path.join(folder, "d.sock")
    shutil.rmtree(folder, ignore_errors=True)


@pytest.fixture
def serve(sock_path):
    servers = []

    def start(handler):
        server = DaemonSocketServer(sock_path, handler)
        server.start()
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.stop()


def raw_request(path, data):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(3)
        sock.connect(path)
        sock.sendall(data)
        sock.shutdown(socket.SHUT_WR)
        out = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                return out
            out += chunk


def test_ida_y_vuelta(sock_path, serve):
    seen = []

    def handler(request):
        seen.append(request)
        return {"ok": True, "eco": request["output"]}

    serve(handler)
    payload = {"op": "test_output", "output": 2, "requested_by": "web local"}
    assert request_daemon(sock_path, payload) == {"ok": True, "eco": 2}
    assert request_daemon(sock_path, payload)["ok"] is True
    assert seen == [payload, payload]


def test_ruta_inexistente_lanza_daemon_unavailable(sock_path):
    with pytest.raises(DaemonUnavailable, match="El daemon no responde"):
        request_daemon(sock_path, {"op": "test_output"})


def test_socket_sin_servidor_lanza_daemon_unavailable(sock_path):
    # Archivo de socket viejo, sin nadie escuchando: la conexión se rechaza.
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.bind(sock_path)
    with pytest.raises(DaemonUnavailable, match="El daemon no responde"):
        request_daemon(sock_path, {"op": "test_output"})


def test_respuesta_que_no_llega_lanza_daemon_unavailable(sock_path):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.bind(sock_path)
        sock.listen(1)  # acepta en la cola pero nunca responde
        with pytest.raises(DaemonUnavailable, match="El daemon no responde"):
            request_daemon(sock_path, {"op": "test_output"}, timeout=0.2)


def test_json_invalido_devuelve_ok_false(sock_path, serve):
    serve(lambda request: {"ok": True})
    reply = raw_request(sock_path, b"{no es json\n")
    assert reply.endswith(b"\n")
    assert reply.decode() == '{"ok": false, "detail": "Petici\\u00f3n inv\\u00e1lida."}\n'


def test_json_que_no_es_objeto_devuelve_ok_false(sock_path, serve):
    serve(lambda request: {"ok": True})
    assert b'"ok": false' in raw_request(sock_path, b"[1, 2]\n")


def test_peticion_demasiado_grande_devuelve_ok_false(sock_path, serve):
    serve(lambda request: {"ok": True})
    assert b'"ok": false' in raw_request(sock_path, b'{"x": "' + b"a" * 5000 + b'"}\n')


def test_handler_que_falla_responde_error_interno(sock_path, serve):
    def handler(request):
        raise RuntimeError("falla")

    serve(handler)
    assert request_daemon(sock_path, {"op": "x"}) == {"ok": False, "detail": "Error interno."}
    # El servidor sigue atendiendo.
    assert request_daemon(sock_path, {"op": "x"})["detail"] == "Error interno."


def test_socket_con_permisos_0600(sock_path, serve):
    serve(lambda request: {"ok": True})
    mode = os.stat(sock_path).st_mode
    assert stat.S_ISSOCK(mode)
    assert stat.S_IMODE(mode) == 0o600


def test_reemplaza_socket_viejo_y_lo_borra_al_detener(sock_path, serve):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.bind(sock_path)
    server = serve(lambda request: {"ok": True})
    assert request_daemon(sock_path, {"op": "x"}) == {"ok": True}
    server.stop()
    assert not os.path.exists(sock_path)


def test_directorio_inexistente_lanza_oserror(sock_path):
    server = DaemonSocketServer(os.path.join(sock_path, "no", "d.sock"), lambda r: {"ok": True})
    with pytest.raises(OSError):
        server.start()


def test_cliente_que_gotea_bytes_se_corta_en_el_plazo_total(sock_path, serve):
    import time
    serve(lambda request: {"ok": True})
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as slow:
        slow.connect(sock_path)
        start = time.monotonic()
        closed_at = None
        for ch in b'{"op": "x", "relleno": "aaaaaaaa"}':
            try:
                slow.sendall(bytes((ch,)))
            except OSError:  # el servidor ya cerró (EPIPE)
                closed_at = time.monotonic() - start
                break
            time.sleep(0.5)
        if closed_at is None:
            slow.settimeout(3)
            assert slow.recv(100) == b""  # cerró sin responder
            closed_at = time.monotonic() - start
    # Cada byte llega antes de 2 s, pero el plazo es por conexión: corta a los ~2 s.
    assert 1.8 <= closed_at <= 3.0
    assert request_daemon(sock_path, {"op": "x"}) == {"ok": True}


def test_respuesta_no_serializable_responde_error_interno_y_sigue(sock_path, serve):
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return {"ok": True, "raro": object()}
        return {"ok": True}

    serve(handler)
    assert request_daemon(sock_path, {"op": "x"}) == {"ok": False, "detail": "Error interno."}
    assert request_daemon(sock_path, {"op": "x"}) == {"ok": True}
