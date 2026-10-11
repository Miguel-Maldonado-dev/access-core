from datetime import datetime

import pytest
from helpers import NOW, add_card, add_control, add_holder, set_permission

from acceso.access import authorize_card, authorize_rf, handle_event, permission_allows
from acceso.protocol import CardRead, ExitButton, RfRead, build_relay_command

LOG_COLUMNS = ("allowed, source, holder_name, holder_kind, credential_label, device_id,"
               " output_id, reason")


def last_log(conn):
    return conn.execute("SELECT * FROM access_logs ORDER BY log_id DESC LIMIT 1").fetchone()


class Sender:
    def __init__(self):
        self.sent = []

    def __call__(self, data):
        self.sent.append(data)


def run(conn, event, now=NOW, send=None, max_entries=1000):
    return handle_event(conn, event, send or Sender(), now=now, max_entries=max_entries)


def test_card_uses_first_enabled_output_for_reader(conn):
    add_card(conn, 111, add_holder(conn), "Llavero")
    outcome = run(conn, CardRead(2, 111))
    assert outcome.allowed and outcome.command == build_relay_command(1, 3000)
    row = conn.execute("SELECT %s FROM access_logs WHERE log_id=?" % LOG_COLUMNS,
                       (outcome.log_id,)).fetchone()
    assert tuple(row) == (1, 0, "Amadeo 1260", "domicilio", "Llavero", 2, 1, 0)


def test_unknown_card(conn):
    outcome = run(conn, CardRead(0, 999))
    assert outcome.reason == 1 and outcome.command is None
    row = last_log(conn)
    assert row["holder_id"] is None and row["code"] == 999


def test_card_without_enabled_output_for_reader(conn):
    add_card(conn, 111, add_holder(conn))
    conn.execute("UPDATE outputs SET enabled=0 WHERE output_id=0")
    assert run(conn, CardRead(0, 111)).reason == 2


def test_card_reader_not_in_permission(conn):
    add_card(conn, 111, add_holder(conn))
    set_permission(conn, 0, output_mask=15, reader_mask=0b0001)
    sender = Sender()
    outcome = run(conn, CardRead(2, 111), send=sender)
    assert outcome.reason == 3
    assert outcome.command is None and sender.sent == []


def test_rf_ignores_reader_mask(conn):
    control_id = add_control(conn, add_holder(conn), [(500, 0)])
    set_permission(conn, 0, output_mask=0b0001, reader_mask=0)
    outcome = run(conn, RfRead(500))
    assert outcome.allowed and outcome.command == build_relay_command(0, 3000)
    row = last_log(conn)
    assert row["credential_label"] == "Control 1"
    assert row["control_id"] == control_id and row["device_id"] == 0


def test_rf_unknown_control(conn):
    assert run(conn, RfRead(777)).reason == 5
    row = last_log(conn)
    assert row["code"] == 777 and row["control_id"] is None


def test_rf_unassigned_button(conn):
    control_id = add_control(conn, add_holder(conn), [(500, None)])
    assert run(conn, RfRead(500)).reason == 6
    row = last_log(conn)
    assert row["control_id"] == control_id and row["device_id"] == 0


def test_rf_disabled_output(conn):
    add_control(conn, add_holder(conn), [(500, 0)])
    conn.execute("UPDATE outputs SET enabled=0 WHERE output_id=0")
    assert run(conn, RfRead(500)).reason == 2


def test_rf_no_permission_keeps_requested_output(conn):
    add_control(conn, add_holder(conn), [(500, 2)])
    set_permission(conn, 0, output_mask=0b0011)
    sender = Sender()
    outcome = run(conn, RfRead(500), send=sender)
    assert outcome.reason == 3
    assert outcome.command is None and sender.sent == []
    assert last_log(conn)["output_id"] == 2


@pytest.mark.parametrize("start, end, now, expected", [
    (480, 1080, NOW, True),
    (480, 1080, NOW.replace(hour=20), False),
    (1320, 360, NOW.replace(hour=23, minute=30), True),
    (1320, 360, NOW.replace(hour=12), False),
    (0, 0, NOW.replace(hour=3), True),
])
def test_schedule_window(conn, start, end, now, expected):
    holder_id = add_holder(conn)
    set_permission(conn, 0, output_mask=15, start_minute=start, end_minute=end)
    assert permission_allows(conn, holder_id, 0, None, now) is expected


def test_weekday_mask(conn):
    add_card(conn, 111, add_holder(conn))
    set_permission(conn, 0, output_mask=15, weekday_mask=0b0011111)
    assert run(conn, CardRead(0, 111), now=datetime(2026, 10, 4, 10)).reason == 3
    assert authorize_card(conn, 111, 0, NOW).reason == 0


def test_authorize_rf_decision(conn):
    add_control(conn, add_holder(conn), [(500, 1)])
    decision = authorize_rf(conn, 500, NOW)
    assert decision.allowed and decision.output.output_id == 1 and decision.button == 0


def test_exit_button_logs_without_sending(conn):
    sender = Sender()
    outcome = run(conn, ExitButton(1), send=sender)
    assert outcome.allowed and outcome.reason == 7 and outcome.command is None
    row = last_log(conn)
    assert row["output_id"] == 1 and row["device_id"] == 1 and row["source"] == 2
    assert sender.sent == []


def test_send_failure_logs_uart_error(conn):
    add_card(conn, 111, add_holder(conn))

    def failing(_data):
        raise OSError("puerto cerrado")

    outcome = run(conn, CardRead(0, 111), send=failing)
    assert not outcome.allowed and outcome.reason == 4
    row = last_log(conn)
    assert row["allowed"] == 0 and row["reason"] == 4 and row["output_id"] == 0


def test_log_trim_keeps_newest(conn):
    for _ in range(5):
        run(conn, RfRead(1), max_entries=3)
    ids = [r[0] for r in conn.execute("SELECT log_id FROM access_logs ORDER BY log_id")]
    assert ids == [3, 4, 5]
