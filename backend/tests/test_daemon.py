import os
import select
import sqlite3
import termios
import threading
import time

import pytest
from helpers import add_card, add_control, add_holder

from acceso.config import load_settings
from acceso.daemon import open_serial_port, run_daemon
from acceso.db import connect
from acceso.protocol import build_relay_command, checksum
from acceso.schema import create_schema


def frame(cmd, payload):
    body = bytes((cmd,)) + payload
    return bytes((0xAA,)) + body + bytes((checksum(body), 0x55))


def card_frame(reader, code):
    return frame(0x10, bytes((reader,)) + code.to_bytes(4, "big"))


def rf_frame(code):
    return frame(0x11, code.to_bytes(4, "big"))


def exit_frame(button):
    return frame(0x12, bytes((button,)))


@pytest.fixture
def settings(tmp_path):
    return load_settings({"UART_PORT": "/dev/fake", "DB_PATH": str(tmp_path / "d.sqlite")})


@pytest.fixture
def db(settings):
    conn = connect(settings.db_path)
    create_schema(conn)
    yield conn
    conn.close()


def start_daemon(settings, **kw):
    stop = threading.Event()
    thread = threading.Thread(target=run_daemon, args=(settings, stop), kwargs=kw, daemon=True)
    thread.start()
    return stop, thread


def log_count(settings):
    conn = sqlite3.connect(str(settings.db_path))
    try:
        return conn.execute("SELECT COUNT(*) FROM access_logs").fetchone()[0]
    finally:
        conn.close()


def wait_for(cond, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def read_master(master, size, timeout=2.0):
    out = b""
    end = time.time() + timeout
    while len(out) < size and time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            out += os.read(master, 64)
    return out


class FakeSerial:
    def __init__(self, chunks=(), then=None, flush_error=None):
        self.chunks = list(chunks)
        self.then = then
        self.flush_error = flush_error
        self.written = []
        self.closed = False

    def read(self, size):
        if self.chunks:
            return self.chunks.pop(0)
        if self.then is not None:
            raise self.then
        time.sleep(0.001)
        return b""

    def write(self, data):
        self.written.append(data)
        return len(data)

    def flush(self):
        if self.flush_error is not None:
            raise self.flush_error

    def close(self):
        self.closed = True


@pytest.fixture
def pty_pair():
    master, slave = os.openpty()
    yield master, os.ttyname(slave)
    os.close(master)
    os.close(slave)


def pty_daemon(settings, uart_port):
    settings = load_settings({"UART_PORT": uart_port, "DB_PATH": str(settings.db_path)})
    opened = threading.Event()

    def open_serial(port, baud):
        ser = open_serial_port(port, baud)
        opened.set()
        return ser

    stop, thread = start_daemon(settings, open_serial=open_serial)
    assert opened.wait(2)
    return settings, stop, thread


def test_pty_card_frame_gets_relay_command(settings, db, pty_pair):
    add_card(db, 111, add_holder(db), "Llavero")
    master, uart_port = pty_pair
    settings, stop, thread = pty_daemon(settings, uart_port)
    os.write(master, card_frame(2, 111))
    assert read_master(master, 8) == build_relay_command(1, 3000)
    stop.set()
    thread.join(2)
    assert not thread.is_alive()


def test_garbage_then_valid_rf_frame(settings, db, pty_pair):
    add_control(db, add_holder(db), [(500, 0)])
    master, uart_port = pty_pair
    settings, stop, thread = pty_daemon(settings, uart_port)
    bad = bytearray(rf_frame(500))
    bad[-2] ^= 0xFF
    os.write(master, b"\x00\xff\xaa\x99")
    os.write(master, bytes(bad))
    os.write(master, rf_frame(500))
    assert read_master(master, 8) == build_relay_command(0, 3000)
    assert read_master(master, 8, timeout=0.3) == b""
    assert wait_for(lambda: log_count(settings) == 1)
    time.sleep(0.2)
    assert log_count(settings) == 1
    stop.set()
    thread.join(2)
    assert not thread.is_alive()


def test_reconnects_every_3_seconds_when_port_unavailable(settings, db):
    calls = []
    sleeps = []
    stop = threading.Event()

    def open_serial(port, baud):
        calls.append(port)
        if len(calls) < 3:
            raise OSError("no existe")
        return FakeSerial([exit_frame(0)], then=OSError("desconectado"))

    def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= 3:
            stop.set()

    run_daemon(settings, stop, open_serial=open_serial, sleep=sleep)
    assert sleeps[:3] == [3.0, 3.0, 3.0]
    assert len(calls) == 3
    rows = db.execute("SELECT source FROM access_logs").fetchall()
    assert [r[0] for r in rows] == [2]


def test_flush_termios_error_logs_uart_error_and_reconnects(settings, db):
    add_card(db, 111, add_holder(db), "Llavero")
    sleeps = []
    stop = threading.Event()
    ports = []

    def open_serial(port, baud):
        if ports:
            return FakeSerial()
        err = termios.error(5, "Input/output error")
        ports.append(FakeSerial([card_frame(2, 111)], then=err, flush_error=err))
        return ports[0]

    def sleep(seconds):
        sleeps.append(seconds)
        stop.set()

    run_daemon(settings, stop, open_serial=open_serial, sleep=sleep)
    assert sleeps == [3.0]
    assert ports[0].closed
    rows = db.execute("SELECT reason FROM access_logs").fetchall()
    assert [r[0] for r in rows] == [4]


def test_stop_event_ends_loop(settings, db):
    stop, thread = start_daemon(settings, open_serial=lambda p, b: FakeSerial())
    time.sleep(0.1)
    stop.set()
    thread.join(1)
    assert not thread.is_alive()
