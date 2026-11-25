from datetime import datetime

import pytest
from helpers import NOW, add_holder, set_permission

from acceso.calls import CallAuthorizer, CallRateLimiter, CallSettings, load_call_settings
from acceso.constants import (
    REASON_ALLOWED, REASON_CALL_LIMIT, REASON_NO_OUTPUT, REASON_NO_PERMISSION,
    REASON_UART_ERROR, REASON_UNKNOWN_PHONE,
)


class Opener:
    def __init__(self, result=True):
        self.result = result
        self.calls = []

    def __call__(self, output, duration_ms):
        self.calls.append((output, duration_ms))
        return self.result


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def opener():
    return Opener()


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def now():
    return [NOW]


@pytest.fixture
def authz(conn, tmp_path, opener, clock, now):
    set_permission(conn, 0, output_mask=0b0011)
    conn.execute("UPDATE permissions SET allow_call = 1 WHERE permission_id = 0")
    holder_id = add_holder(conn, "Ana", permission_ids=(0,))
    conn.execute("INSERT INTO phones(holder_id, number, uuid, updated_at) VALUES (?, ?, 'u1', 1)",
                 (holder_id, "5512345678"))
    return CallAuthorizer(tmp_path / "test.sqlite", opener, 1000, wall=lambda: 1700000000.7,
                          now=lambda: now[0], clock=clock)


def last_log(conn):
    return conn.execute("SELECT * FROM access_logs ORDER BY log_id DESC LIMIT 1").fetchone()


KNOWN = '"+5215512345678",145'


def test_identify_unknown_and_hidden(authz):
    lookup = authz.identify('"",128')
    assert lookup.holder is None and lookup.label == "Oculto" and lookup.number is None


def test_identify_known_variants(authz):
    for raw in ('"+5215512345678",145', '"5512345678",129', '"+525512345678",145'):
        lookup = authz.identify(raw)
        assert lookup.holder.name == "Ana" and lookup.number == "5512345678"


def test_clip_international_is_unknown(authz):
    lookup = authz.identify('"+15551234567",145')
    assert lookup.holder is None and lookup.number is None
    assert lookup.label == "+15551234567"


def test_identify_valid_unregistered_number(authz):
    lookup = authz.identify('"5598765432",129')
    assert lookup.holder is None and lookup.number == "5598765432"


def test_open_allowed_logs_full_number(authz, conn, opener):
    assert authz.open(authz.identify(KNOWN), 0, None) == REASON_ALLOWED
    log = last_log(conn)
    assert (log["source"], log["credential_label"], log["code"], log["allowed"]) == (
        6, "5512345678", None, 1)
    assert log["holder_name"] == "Ana" and log["output_id"] == 0 and log["device_id"] is None
    assert len(opener.calls) == 1


def test_open_logs_key(authz, conn):
    authz.open(authz.identify(KNOWN), 1, 2)
    assert last_log(conn)["device_id"] == 2


def test_open_output_not_in_mask_is_3(authz, conn, opener):
    assert authz.open(authz.identify(KNOWN), 2, 3) == REASON_NO_PERMISSION
    log = last_log(conn)
    assert (log["reason"], log["allowed"], log["device_id"], log["output_id"]) == (3, 0, 3, 2)
    assert opener.calls == []


def test_permission_without_allow_call_is_3(authz, conn):
    conn.execute("UPDATE permissions SET allow_call = 0")
    assert authz.open(authz.identify(KNOWN), 0, None) == REASON_NO_PERMISSION


def test_permission_outside_schedule_is_3(authz, conn):
    conn.execute("UPDATE permissions SET start_minute = 0, end_minute = 60")  # 00:00-01:00
    assert authz.open(authz.identify(KNOWN), 0, None) == REASON_NO_PERMISSION


def test_disabled_output_is_2(authz, conn, opener):
    conn.execute("UPDATE outputs SET enabled = 0 WHERE output_id = 0")
    assert authz.open(authz.identify(KNOWN), 0, None) == REASON_NO_OUTPUT
    assert last_log(conn)["reason"] == 2 and opener.calls == []


def test_busy_output_logs_reason_0_not_allowed(authz, conn, opener):
    opener.result = None
    assert authz.open(authz.identify(KNOWN), 0, None) == REASON_ALLOWED
    log = last_log(conn)
    assert (log["reason"], log["allowed"]) == (0, 0)


def test_uart_error_is_4(authz, conn, opener):
    opener.result = False
    assert authz.open(authz.identify(KNOWN), 0, None) == REASON_UART_ERROR
    assert last_log(conn)["allowed"] == 0


def test_busy_does_not_count_for_limit(authz, opener):
    opener.result = None
    lookup = authz.identify(KNOWN)
    for _ in range(4):
        authz.open(lookup, 0, None)
    assert authz.pre_check(lookup, CallSettings(True, "single", 0, 0, None)) is None


def test_rate_limit_after_three_openings(authz, clock):
    lookup = authz.identify(KNOWN)
    settings = CallSettings(True, "single", 0, 0, None)
    for _ in range(3):
        assert authz.pre_check(lookup, settings) is None
        assert authz.open(lookup, 0, None) == REASON_ALLOWED
    assert authz.pre_check(lookup, settings) == REASON_CALL_LIMIT
    clock.now += 61
    assert authz.pre_check(lookup, settings) is None


def test_menu_outputs_intersects_settings_and_permissions(authz):
    lookup = authz.identify(KNOWN)
    s = CallSettings(True, "menu", 0, 0b0101, None)
    assert authz.menu_outputs(lookup, s) == {0}


def test_menu_outputs_unknown_is_empty(authz):
    s = CallSettings(True, "menu", 0, 0b0101, None)
    assert authz.menu_outputs(authz.identify('"",128'), s) == frozenset()


def test_pre_check_unknown_is_12(authz):
    s = CallSettings(True, "single", 0, 0, None)
    assert authz.pre_check(authz.identify('"",128'), s) == REASON_UNKNOWN_PHONE
    assert authz.pre_check(authz.identify('"5598765432",129'), s) == REASON_UNKNOWN_PHONE


def test_pre_check_no_eligible_permitted_is_3(authz):
    lookup = authz.identify(KNOWN)
    assert authz.pre_check(lookup, CallSettings(True, "single", 3, 0, None)) == REASON_NO_PERMISSION
    assert authz.pre_check(lookup, CallSettings(True, "menu", 0, 0b1100, None)) == REASON_NO_PERMISSION
    assert authz.pre_check(lookup, CallSettings(True, "menu", 0, 0b1101, None)) is None


def test_reject_only_logs(authz, conn, opener):
    authz.reject(authz.identify('"",128'), REASON_UNKNOWN_PHONE)
    log = last_log(conn)
    assert (log["source"], log["reason"], log["allowed"], log["credential_label"]) == (
        6, 12, 0, "Oculto")
    assert opener.calls == []


def test_reject_known_with_key(authz, conn):
    authz.reject(authz.identify(KNOWN), REASON_NO_PERMISSION, 4)
    log = last_log(conn)
    assert log["holder_name"] == "Ana" and log["device_id"] == 4 and log["output_id"] is None


def test_configured_limit_one(authz):
    lookup = authz.identify(KNOWN)
    settings = CallSettings(True, "single", 0, 0, None, 1)
    assert authz.pre_check(lookup, settings) is None
    assert authz.open(lookup, 0, None) == REASON_ALLOWED
    assert authz.pre_check(lookup, settings) == REASON_CALL_LIMIT


def test_configured_limit_five(authz):
    lookup = authz.identify(KNOWN)
    settings = CallSettings(True, "single", 0, 0, None, 5)
    for _ in range(4):
        assert authz.pre_check(lookup, settings) is None
        assert authz.open(lookup, 0, None) == REASON_ALLOWED
    assert authz.pre_check(lookup, settings) is None  # la quinta pasa
    authz.open(lookup, 0, None)
    assert authz.pre_check(lookup, settings) == REASON_CALL_LIMIT


def test_limiter_window():
    limiter = CallRateLimiter()
    for t in (0, 1, 2):
        limiter.record("5512345678", t)
    assert not limiter.allowed("5512345678", 30)
    assert limiter.allowed("5512345678", 60.5)
    assert limiter.allowed("5500000000", 30)


def test_load_call_settings(conn):
    s = load_call_settings(conn)
    assert s == CallSettings(False, "single", 0, 0, None, 3)
    conn.execute("UPDATE call_settings SET enabled=1, mode='menu', menu_mask=5, default_output=2,"
                 " call_limit_per_minute=7")
    assert load_call_settings(conn) == CallSettings(True, "menu", 0, 5, 2, 7)
