import logging
import threading
import time

import pytest
import serial
from fake_modem import FakeModem
from helpers import NOW, add_holder, set_permission

from acceso.calls import CallAuthorizer
from acceso.config import load_settings
from acceso.gsm import GsmService
from acceso.output_test import OutputTester, RelayLink
from acceso.protocol import build_relay_command

KNOWN = '+CLIP: "+5215512345678",145,"",0,"",0'


class FakeClock:
    def __init__(self, step=0.0):
        self.now = 100.0
        self.step = step
        self._lock = threading.Lock()

    def __call__(self):
        with self._lock:
            self.now += self.step
            return self.now

    def advance(self, seconds):
        with self._lock:
            self.now += seconds


def wait_for(cond, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.005)
    return cond()


class Env:
    def __init__(self, conn, tmp_path, modems=None, step=0.0, enabled=1, port="/dev/gsm"):
        self.conn = conn
        conn.execute("UPDATE call_settings SET enabled = ?, mode = 'single', output_id = 0"
                     " WHERE id = 1", (enabled,))
        set_permission(conn, 0, output_mask=0b0011)
        conn.execute("UPDATE permissions SET allow_call = 1 WHERE permission_id = 0")
        holder = add_holder(conn, "Ana", permission_ids=(0,))
        conn.execute("INSERT INTO phones(holder_id, number, uuid, updated_at)"
                     " VALUES (?, '5512345678', 'p1', 1)", (holder,))
        db = tmp_path / "test.sqlite"
        self.settings = load_settings({"DB_PATH": str(db), "GSM_PORT": port})
        self.frames = []
        relay = RelayLink()
        relay.set(self.frames.append)
        self.clock = FakeClock(step)
        tester = OutputTester(db, relay, 1000, clock=self.clock)
        self.authz = CallAuthorizer(db, tester.send_if_free, 1000, now=lambda: NOW,
                                    clock=self.clock)
        self.modems = list(modems) if modems is not None else [FakeModem()]
        self.opened = []
        self.stop = threading.Event()
        self.service = GsmService(self.settings, self.authz, open_port=self._open,
                                  clock=self.clock, sleep=lambda s: self.stop.wait(0.01))
        self.thread = threading.Thread(target=self.service.run, args=(self.stop,), daemon=True)

    def _open(self, port, baud):
        self.opened.append((port, baud))
        modem = self.modems[min(len(self.opened), len(self.modems)) - 1]
        if modem.fail_open:
            raise serial.SerialException("no existe")
        return modem

    @property
    def modem(self):
        return self.modems[0]

    def menu(self, mask=0b0011, default=None):
        self.conn.execute("UPDATE call_settings SET mode = 'menu', menu_mask = ?,"
                          " default_output = ? WHERE id = 1", (mask, default))

    def start(self):
        self.thread.start()
        assert self.modem.wait_written(b"AT+CSQ\r")
        return self

    def logs(self):
        return self.conn.execute("SELECT * FROM access_logs ORDER BY log_id").fetchall()

    def close(self):
        self.stop.set()
        self.thread.join(2)
        assert not self.thread.is_alive()


@pytest.fixture
def env(conn, tmp_path):
    made = []

    def make(**kw):
        e = Env(conn, tmp_path, **kw)
        made.append(e)
        return e

    yield make
    for e in made:
        if e.thread.is_alive():
            e.close()


def test_init_sends_at_commands(env):
    e = env().start()
    assert e.modem.written[:5] == [b"ATE0\r", b"AT+CLIP=1\r", b"AT+DDET=1\r", b"AT+CMEE=2\r",
                                  b"AT+CCWA=0\r"]
    assert e.opened == [("/dev/gsm", 9600)]


def test_ccwa_error_is_optional(env, caplog):
    caplog.set_level(logging.WARNING)
    script = dict(FakeModem().script)
    script[b"AT+CCWA=0\r"] = b"\r\nERROR\r\n"
    e = env(modems=[FakeModem(script=script)]).start()
    assert "no aceptó AT+CCWA=0" in caplog.text
    assert e.opened == [("/dev/gsm", 9600)]
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    assert e.frames == [build_relay_command(0, 3000)]


def test_clip_single_mode_hangs_up_and_opens(env):
    e = env().start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    assert e.frames == [build_relay_command(0, 3000)]
    log = e.logs()[0]
    assert (log["source"], log["reason"], log["allowed"], log["output_id"]) == (6, 0, 1, 0)
    assert log["credential_label"] == "5512345678" and log["code"] is None
    assert b"ATA\r" not in e.modem.written


def test_hidden_number_hangs_up_logs_12(env):
    e = env().start()
    e.modem.push("RING")
    e.modem.push('+CLIP: "",128,"",0,"",0')
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    log = e.logs()[0]
    assert (log["reason"], log["allowed"], log["credential_label"]) == (12, 0, "Oculto")
    assert e.frames == []


def test_unauthorized_hangs_up_logs_3(env):
    e = env()
    e.conn.execute("UPDATE call_settings SET output_id = 2 WHERE id = 1")  # S3 fuera del permiso
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    assert e.logs()[0]["reason"] == 3 and e.frames == []


def test_menu_valid_key_opens_that_output(env):
    e = env()
    e.menu()
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r")
    e.modem.push("+DTMF: 2")
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    log = e.logs()[0]
    assert (log["reason"], log["allowed"], log["output_id"], log["device_id"]) == (0, 1, 1, 2)
    assert e.frames == [build_relay_command(1, 3000)]
    assert e.modem.written.index(b"ATA\r") < e.modem.written.index(b"ATH\r")


def test_menu_key_not_allowed_then_timeout_default(env):
    e = env()
    e.menu(mask=0b1011, default=0)
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r")
    e.modem.push("+DTMF: 4")  # S4 no está en el permiso
    time.sleep(0.05)
    assert e.logs() == []
    e.clock.advance(8)
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    log = e.logs()[0]
    assert (log["reason"], log["allowed"], log["output_id"], log["device_id"]) == (0, 1, 0, 4)
    assert e.frames == [build_relay_command(0, 3000)]


def test_menu_timeout_without_default_logs_3(env):
    e = env()
    e.menu()
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r")
    e.clock.advance(8)
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    log = e.logs()[0]
    assert (log["reason"], log["allowed"], log["device_id"]) == (3, 0, None)
    assert e.frames == []


def test_menu_default_outside_permission_logs_3(env):
    e = env()
    e.menu(mask=0b0101, default=2)  # S3 en el menú pero no en el permiso
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r")
    e.modem.push("+DTMF: 3")
    time.sleep(0.05)
    e.clock.advance(8)
    assert wait_for(lambda: e.logs())
    log = e.logs()[0]
    assert (log["reason"], log["device_id"]) == (3, 3) and e.frames == []


def test_menu_without_allowed_outputs_rejects_without_answering(env):
    e = env()
    e.menu(mask=0b1100)
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    assert e.logs()[0]["reason"] == 3 and b"ATA\r" not in e.modem.written


def test_menu_caller_hangs_up(env):
    e = env()
    e.menu(default=1)
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r")
    e.modem.push("NO CARRIER")
    assert wait_for(lambda: e.logs())
    log = e.logs()[0]
    assert (log["reason"], log["allowed"], log["output_id"]) == (0, 1, 1)
    assert b"ATH\r" not in e.modem.written  # ya colgó quien llamó
    # La siguiente llamada se atiende normalmente.
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r", 2)


def test_second_call_during_menu_is_hung_up(env):
    e = env()
    e.menu()
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r")
    e.modem.push("RING")
    e.modem.push('+CLIP: "5587654321",129,"",0,"",0')
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    time.sleep(0.05)
    logs = e.logs()
    assert len(logs) == 1 and logs[0]["credential_label"] == "5512345678"


def test_ring_repeats_handled_once(env):
    e = env().start()
    for line in ("RING", KNOWN, "RING", "RING"):
        e.modem.push(line)
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    time.sleep(0.05)
    assert len(e.logs()) == 1 and e.modem.written.count(b"ATH\r") == 1


def test_rate_limit_logs_13(env):
    e = env().start()
    for i in range(4):
        e.modem.push("RING")
        e.modem.push(KNOWN)
        assert e.modem.wait_written(b"ATH\r", i + 1)
        assert wait_for(lambda: len(e.logs()) == i + 1)
        e.modem.push("NO CARRIER")
        e.clock.advance(4)  # salida libre de nuevo; sigue dentro del minuto
    assert [r["reason"] for r in e.logs()] == [0, 0, 0, 13]
    assert len(e.frames) == 3


def test_module_not_responding_retries(env, caplog):
    caplog.set_level(logging.WARNING)
    e = env(modems=[FakeModem(script={}), FakeModem()], step=0.5)
    e.thread.start()
    assert e.modems[1].wait_written(b"AT+CSQ\r")
    assert "El módulo GSM no responde en /dev/gsm" in caplog.text
    assert e.modems[0].closed.is_set() and len(e.opened) == 2


def test_port_disconnected_retries(env):
    first = FakeModem()
    e = env(modems=[first, FakeModem()]).start()
    first.read_error = serial.SerialException("desconectado")
    assert e.modems[1].wait_written(b"ATE0\r")
    assert first.closed.is_set() and len(e.opened) == 2
    assert e.service.status()["connected"] in (True, False)


def test_open_failure_retries(env):
    e = env(modems=[FakeModem(fail_open=True), FakeModem()])
    e.thread.start()
    assert e.modems[1].wait_written(b"ATE0\r")


def test_disabled_does_not_open_port(env):
    e = env(enabled=0)
    e.thread.start()
    time.sleep(0.1)
    assert e.opened == []
    assert e.service.status() == {"ok": True, "enabled": False, "port": "/dev/gsm",
                                  "connected": False, "registered": None, "signal": None}


def test_empty_port_does_not_open(env):
    e = env(port="")
    e.thread.start()
    time.sleep(0.1)
    assert e.opened == []
    assert e.service.status()["enabled"] is True and e.service.status()["port"] == ""


def test_disable_closes_port(env):
    e = env().start()
    e.conn.execute("UPDATE call_settings SET enabled = 0 WHERE id = 1")
    e.clock.advance(3)
    assert e.modem.closed.wait(2)
    assert wait_for(lambda: e.service.status()["enabled"] is False)
    assert e.service.status()["connected"] is False and len(e.opened) == 1


def test_disable_during_menu_hangs_up_without_opening(env):
    e = env()
    e.menu(default=0)
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r")
    e.conn.execute("UPDATE call_settings SET enabled = 0 WHERE id = 1")
    e.clock.advance(3)
    assert e.modem.wait_written(b"ATH\r")
    assert e.modem.closed.wait(2)
    assert e.frames == [] and e.logs() == []


def test_status_reports_signal_and_registration(env):
    e = env().start()
    assert wait_for(lambda: e.service.status()["signal"] == 18)
    assert e.service.status() == {"ok": True, "enabled": True, "port": "/dev/gsm",
                                  "connected": True, "registered": True, "signal": 18}
    assert e.service.handle({"op": "gsm_status"}) == e.service.status()


def test_status_polls_every_30_seconds(env):
    e = env().start()
    e.modem.script[b"AT+CSQ\r"] = b"\r\n+CSQ: 99,99\r\n\r\nOK\r\n"
    e.modem.script[b"AT+CREG?\r"] = b"\r\n+CREG: 0,2\r\n\r\nOK\r\n"
    e.clock.advance(30)
    assert e.modem.wait_written(b"AT+CSQ\r", 2)
    assert wait_for(lambda: e.service.status()["signal"] is None)
    assert e.service.status()["registered"] is False


def test_new_call_after_quiet_is_handled(env):
    e = env().start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: len(e.logs()) == 1)
    e.clock.advance(3)
    time.sleep(0.03)
    e.modem.push("RING")
    e.modem.push('+CLIP: "",128,"",0,"",0')
    assert e.modem.wait_written(b"ATH\r", 2)
    assert wait_for(lambda: len(e.logs()) == 2)
    assert e.logs()[1]["reason"] == 12


def test_ccwa_during_menu_is_hung_up(env):
    e = env()
    e.menu()
    e.start()
    e.modem.push("RING")
    e.modem.push(KNOWN)
    assert e.modem.wait_written(b"ATA\r")
    e.modem.push('+CCWA: "5587654321",129,1')
    assert e.modem.wait_written(b"ATH\r")
    assert wait_for(lambda: e.logs())
    time.sleep(0.05)
    logs = e.logs()
    assert len(logs) == 1 and logs[0]["credential_label"] == "5512345678"


def test_ring_without_clip_hangs_up(env):
    e = env().start()
    e.modem.push("RING")
    time.sleep(0.05)
    assert b"ATH\r" not in e.modem.written
    e.clock.advance(6)
    assert e.modem.wait_written(b"ATH\r")
    time.sleep(0.05)
    assert e.logs() == []


def test_status_survives_db_error(env, tmp_path):
    e = env()
    e.service._settings = load_settings({"DB_PATH": str(tmp_path / "no" / "x.sqlite")})
    assert e.service.status()["ok"] is True
