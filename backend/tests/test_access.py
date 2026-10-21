from datetime import datetime, timedelta

import pytest
from helpers import NOW, add_card, add_control, add_holder, set_permission

from acceso.access import PinLockout, authorize_card, authorize_rf, handle_event, permission_allows
from acceso.protocol import CardRead, ExitButton, PinRead, RfRead, build_relay_command

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


def pin_holder(conn, pin="123456", allow_pin=1, name="Ana", **kw):
    set_permission(conn, 0, output_mask=15, allow_pin=allow_pin, **kw)
    return add_holder(conn, name=name, kind="persona", pin=pin)


def test_pin_opens_first_output_for_reader_and_log_has_no_digits(conn):
    pin_holder(conn)
    sender = Sender()
    outcome = run(conn, PinRead(2, "123456"), send=sender)
    assert outcome.allowed and outcome.reason == 0
    assert outcome.command == build_relay_command(1, 3000) and sender.sent == [outcome.command]
    row = conn.execute("SELECT * FROM access_logs WHERE log_id=?", (outcome.log_id,)).fetchone()
    assert (row["allowed"], row["source"], row["holder_name"], row["holder_kind"],
            row["credential_label"], row["device_id"], row["output_id"], row["reason"]) == (
        1, 3, "Ana", "persona", "PIN", 2, 1, 0)
    assert row["code"] is None
    assert "123456" not in str(tuple(row))


def test_pin_leading_zeros_are_distinct(conn):
    pin_holder(conn, pin="0123")
    assert run(conn, PinRead(0, "0123")).allowed
    assert run(conn, PinRead(0, "123")).reason == 8


def test_unknown_pin_logs_without_digits_and_sends_nothing(conn):
    pin_holder(conn)
    sender = Sender()
    outcome = run(conn, PinRead(1, "999999"), send=sender)
    assert outcome.reason == 8 and not outcome.allowed
    assert outcome.command is None and sender.sent == []
    row = last_log(conn)
    assert (row["source"], row["holder_id"], row["credential_label"], row["device_id"],
            row["reason"], row["allowed"]) == (3, None, "PIN", 1, 8, 0)
    assert row["code"] is None and "999999" not in str(tuple(row))


def test_pin_without_allow_pin_permission_is_not_allowed(conn):
    pin_holder(conn, allow_pin=0)
    sender = Sender()
    outcome = run(conn, PinRead(0, "123456"), send=sender)
    assert outcome.reason == 9 and outcome.command is None and sender.sent == []
    row = last_log(conn)
    assert row["holder_name"] == "Ana" and row["code"] is None and row["credential_label"] == "PIN"
    assert row["output_id"] == 0 and "123456" not in str(tuple(row))


def test_only_allow_pin_permissions_count_for_pin(conn):
    set_permission(conn, 0, output_mask=15, allow_pin=0)
    set_permission(conn, 1, output_mask=0b0001, allow_pin=1)
    add_holder(conn, pin="4321", permission_ids=(0,))
    assert run(conn, PinRead(0, "4321")).reason == 9
    conn.execute("INSERT INTO holder_permissions(holder_id, permission_id) VALUES (1, 1)")
    assert run(conn, PinRead(0, "4321")).allowed


def test_pin_permission_must_cover_reader_and_schedule(conn):
    pin_holder(conn, reader_mask=0b0001)
    assert run(conn, PinRead(0, "123456")).allowed
    assert run(conn, PinRead(2, "123456")).reason == 9
    set_permission(conn, 0, output_mask=15, allow_pin=1, start_minute=0, end_minute=60)
    assert run(conn, PinRead(0, "123456")).reason == 9


def test_pin_with_card_permission_but_card_still_works_without_allow_pin(conn):
    pin_holder(conn, allow_pin=0)
    add_card(conn, 111, 1)
    assert run(conn, CardRead(0, 111)).allowed


def test_pin_without_enabled_output_is_reason_2(conn):
    pin_holder(conn)
    conn.execute("UPDATE outputs SET enabled=0 WHERE output_id=0")
    sender = Sender()
    outcome = run(conn, PinRead(0, "123456"), send=sender)
    assert outcome.reason == 2 and sender.sent == []
    assert last_log(conn)["holder_name"] == "Ana"


def test_pin_send_failure_logs_uart_error(conn):
    pin_holder(conn)

    def broken(data):
        raise OSError("sin puerto")

    outcome = run(conn, PinRead(0, "123456"), send=broken)
    assert outcome.reason == 4 and outcome.command is None
    assert last_log(conn)["code"] is None


def run_pin(conn, reader, pin, lockout, sender=None, now=NOW):
    return handle_event(conn, PinRead(reader, pin), sender or Sender(), now=now,
                        max_entries=1000, pin_lockout=lockout)


def test_pin_lockout_after_five_failures_per_reader(conn):
    pin_holder(conn)
    lockout = PinLockout()
    for _ in range(5):
        assert run_pin(conn, 0, "999999", lockout).reason == 8
    sender = Sender()
    blocked = run_pin(conn, 0, "123456", lockout, sender)
    assert blocked.reason == 10 and not blocked.allowed and blocked.command is None
    assert sender.sent == []
    row = last_log(conn)
    assert (row["reason"], row["holder_id"], row["code"], row["device_id"], row["source"]) == (
        10, None, None, 0, 3)
    assert run_pin(conn, 1, "123456", lockout).allowed
    # cartas y RF no se afectan
    add_card(conn, 111, 1)
    assert run(conn, CardRead(0, 111)).allowed
    later = NOW + timedelta(seconds=300)
    assert run_pin(conn, 0, "123456", lockout, now=later).allowed


def test_pin_lockout_not_lifted_before_time(conn):
    pin_holder(conn)
    lockout = PinLockout()
    for _ in range(5):
        run_pin(conn, 0, "999999", lockout)
    assert run_pin(conn, 0, "123456", lockout, now=NOW + timedelta(seconds=299)).reason == 10


def test_pin_success_resets_failure_counter(conn):
    pin_holder(conn)
    lockout = PinLockout()
    for _ in range(4):
        run_pin(conn, 0, "999999", lockout)
    assert run_pin(conn, 0, "123456", lockout).allowed
    for _ in range(4):
        assert run_pin(conn, 0, "999999", lockout).reason == 8
    assert run_pin(conn, 0, "123456", lockout).allowed


def test_pin_failures_outside_window_do_not_add_up(conn):
    pin_holder(conn)
    lockout = PinLockout()
    for i in range(4):
        run_pin(conn, 0, "999999", lockout, now=NOW + timedelta(seconds=i))
    later = NOW + timedelta(seconds=400)
    assert run_pin(conn, 0, "999999", lockout, now=later).reason == 8
    assert run_pin(conn, 0, "123456", lockout, now=later).allowed


def test_not_allowed_pin_counts_as_failure_but_no_output_does_not(conn):
    pin_holder(conn, allow_pin=0)
    lockout = PinLockout()
    for _ in range(5):
        assert run_pin(conn, 0, "123456", lockout).reason == 9
    assert run_pin(conn, 0, "123456", lockout).reason == 10
    conn2_lockout = PinLockout()
    conn.execute("UPDATE outputs SET enabled=0")
    for _ in range(6):
        assert run_pin(conn, 2, "123456", conn2_lockout).reason == 2


def test_no_lockout_object_means_no_lockout(conn):
    pin_holder(conn)
    for _ in range(8):
        run(conn, PinRead(0, "999999"))
    assert run(conn, PinRead(0, "123456")).allowed
