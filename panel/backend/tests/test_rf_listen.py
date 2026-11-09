import threading

from helpers import NOW, add_control, add_holder, set_permission

from acceso import rf_listen
from acceso.access import handle_event
from acceso.db import connect
from acceso.protocol import RfRead, build_relay_command
from acceso.rf_listen import RfListener
from acceso.schema import create_schema


def make_db(tmp_path):
    path = tmp_path / "l.sqlite"
    conn = connect(path)
    create_schema(conn)
    return path, conn


def start_listen(listener):
    """Lanza handle en un hilo y espera a que la escucha esté activa."""
    result = {}
    thread = threading.Thread(target=lambda: result.update(listener.handle({"op": "listen_rf"})))
    thread.start()
    for _ in range(500):
        with listener._cond:
            if listener._active:
                break
        threading.Event().wait(0.01)
    return thread, result


def test_listen_returns_first_code(tmp_path):
    path, _ = make_db(tmp_path)
    listener = RfListener(path)
    thread, result = start_listen(listener)
    assert listener.offer(123) is True
    thread.join(3)
    assert result["ok"] is True and result["code"] == 123 and result["control"] is None
    assert listener.offer(124) is False


def test_listen_reports_known_control(tmp_path):
    path, conn = make_db(tmp_path)
    cid = add_control(conn, add_holder(conn), [(555, 0)], description="Portón")
    conn.commit()
    listener = RfListener(path)
    thread, result = start_listen(listener)
    listener.offer(555)
    thread.join(3)
    assert result["control"] == {"control_id": cid, "description": "Portón"}


def test_listen_times_out(tmp_path, monkeypatch):
    monkeypatch.setattr(rf_listen, "LISTEN_SECONDS", 0.1)
    path, _ = make_db(tmp_path)
    listener = RfListener(path)
    assert listener.handle({"op": "listen_rf"}) == {"ok": False,
                                                    "detail": "No se recibió ningún control."}
    assert listener.offer(1) is False


def test_listen_busy(tmp_path):
    path, _ = make_db(tmp_path)
    listener = RfListener(path)
    thread, result = start_listen(listener)
    assert listener.handle({"op": "listen_rf"}) == {"ok": False,
                                                    "detail": "Ya hay una escucha en curso."}
    listener.offer(7)
    thread.join(3)
    assert result["code"] == 7


def test_offer_without_listener_is_false(tmp_path):
    path, _ = make_db(tmp_path)
    assert RfListener(path).offer(1) is False


def test_known_rf_opens_and_feeds_listener(tmp_path):
    path, conn = make_db(tmp_path)
    add_control(conn, add_holder(conn), [(555, 0)])
    set_permission(conn, 0, output_mask=1, allow_rf=1)
    conn.commit()
    listener = RfListener(path)
    thread, result = start_listen(listener)
    sent = []
    outcome = handle_event(conn, RfRead(555), sent.append, now=NOW, max_entries=100,
                           rf_listener=listener)
    thread.join(3)
    assert outcome.allowed is True
    assert sent == [build_relay_command(0, 3000)]
    assert result["code"] == 555
    assert conn.execute("SELECT COUNT(*) FROM access_logs").fetchone()[0] == 1
