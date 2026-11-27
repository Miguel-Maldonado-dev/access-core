from datetime import timedelta

import pytest
from helpers import NOW, add_card, add_holder, set_permission, stamp

from acceso.access import QrDebounce, handle_event
from acceso.logs import purge_expired_qr
from acceso.protocol import CardRead

T0 = int(NOW.timestamp())
CODE = 912345678


class Sender:
    def __init__(self, error=False):
        self.sent, self.error = [], error

    def __call__(self, data):
        if self.error:
            raise OSError("puerto")
        self.sent.append(data)


def add_qr(conn, holder_id, code=CODE, label="Visita Juan", valid_from=T0 - 100,
           valid_until=T0 + 3600, max_uses=1):
    cur = conn.execute(
        "INSERT INTO qr_codes(holder_id, code, label, valid_from, valid_until, max_uses,"
        " created_at, uuid, updated_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (holder_id, code, label, valid_from, valid_until, max_uses, T0) + stamp())
    return cur.lastrowid


@pytest.fixture
def host(conn):
    conn.execute("UPDATE outputs SET enabled=1, reader_mask=15 WHERE output_id=0")
    conn.execute("UPDATE outputs SET enabled=0 WHERE output_id!=0")
    holder_id = add_holder(conn, "Ana", "persona")
    set_permission(conn, 0, output_mask=1, card_reader_mask=0b0001, qr_reader_mask=0b0011)
    return holder_id


def read(conn, reader=0, code=CODE, at=0, deb=None, send=None, clock=0.0):
    return handle_event(conn, CardRead(reader, code), send or Sender(),
                        now=NOW + timedelta(seconds=at), max_entries=1000,
                        qr_debounce=deb, clock=lambda: clock)


def uses(conn):
    return conn.execute("SELECT count FROM qr_uses").fetchall()


def last_log(conn):
    return conn.execute("SELECT * FROM access_logs ORDER BY log_id DESC LIMIT 1").fetchone()


def test_qr_opens_and_counts_use(conn, host):
    add_qr(conn, host)
    out = read(conn, 1, deb=QrDebounce())
    assert out.allowed and conn.execute("SELECT count FROM qr_uses").fetchone()[0] == 1
    log = last_log(conn)
    assert (log["source"], log["code"], log["credential_label"], log["device_id"]) == (
        7, CODE, "Visita Juan", 1)


def test_second_read_same_reader_is_16(conn, host):
    add_qr(conn, host)
    assert read(conn, 0).allowed
    out = read(conn, 0, at=10)
    assert out.reason == 16 and not out.allowed
    assert [r[0] for r in uses(conn)] == [1]


def test_one_use_per_reader(conn, host):
    add_qr(conn, host)
    assert read(conn, 0).allowed and read(conn, 1, at=1).allowed
    assert read(conn, 0, at=2).reason == 16 and read(conn, 1, at=2).reason == 16


def test_debounce_then_used(conn, host):
    add_qr(conn, host)
    deb = QrDebounce()
    assert read(conn, 0, deb=deb, clock=100.0).allowed
    out = read(conn, 0, at=2, deb=deb, clock=102.0)
    assert out.log_id is None and out.reason == 16
    assert conn.execute("SELECT COUNT(*) FROM access_logs").fetchone()[0] == 1
    out = read(conn, 0, at=4, deb=deb, clock=104.0)
    assert out.reason == 16 and out.log_id is not None


def test_validity_bounds(conn, host):
    add_qr(conn, host, valid_from=T0 + 10, valid_until=T0 + 20, max_uses=5)
    assert read(conn, 0, at=20).reason == 15
    assert read(conn, 0, at=9).reason == 15
    assert read(conn, 0, at=10).allowed


def test_qr_reader_not_enabled_is_17(conn, host):
    add_qr(conn, host)
    out = read(conn, 2)
    assert out.reason == 17 and uses(conn) == []


def test_unknown_qr_format_is_14(conn, host):
    out = read(conn, 0, code=987654321)
    assert out.reason == 14
    log = last_log(conn)
    assert log["source"] == 7 and log["holder_id"] is None and log["code"] == 987654321


def test_registered_card_in_qr_range_still_opens(conn, host):
    add_card(conn, 955555555, host)
    out = read(conn, 0, code=955555555)
    assert out.allowed and last_log(conn)["source"] == 0


def test_card_in_qr_only_reader_is_17(conn, host):
    add_card(conn, 955555555, host)
    assert read(conn, 1, code=955555555).reason == 17


def test_old_digit_qr_still_opens_after_digit_change(conn, host):
    add_qr(conn, host)
    conn.execute("UPDATE qr_settings SET digit=5")
    assert read(conn, 0).allowed
    assert read(conn, 0, code=911111111).reason == 1


def test_no_output_does_not_consume(conn, host):
    add_qr(conn, host)
    conn.execute("UPDATE outputs SET enabled=0")
    assert read(conn, 0).reason == 2 and uses(conn) == []


def test_schedule_outside_is_3_without_use(conn, host):
    add_qr(conn, host)
    set_permission(conn, 0, output_mask=1, card_reader_mask=1, qr_reader_mask=3,
                   start_minute=20 * 60, end_minute=21 * 60)
    assert read(conn, 0).reason == 3 and uses(conn) == []


def test_uart_error_does_not_consume(conn, host):
    add_qr(conn, host)
    assert read(conn, 0, send=Sender(error=True)).reason == 4
    assert uses(conn) == []


def test_purge_expired_qr(conn, host):
    old = add_qr(conn, host, code=911111111, valid_from=T0 - 40 * 86400,
                 valid_until=T0 - 31 * 86400)
    keep = add_qr(conn, host, code=922222222, valid_from=T0 - 40 * 86400,
                  valid_until=T0 - 29 * 86400)
    for qr_id in (old, keep):
        conn.execute("INSERT INTO qr_uses(qr_id, reader, count) VALUES (?, 0, 1)", (qr_id,))
    conn.execute("DELETE FROM sync_outbox")
    assert purge_expired_qr(conn, float(T0)) == 1
    assert [r[0] for r in conn.execute("SELECT qr_id FROM qr_codes")] == [keep]
    assert [r[0] for r in conn.execute("SELECT qr_id FROM qr_uses")] == [keep]
    assert conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0] == 0


# Compatibilidad de lectores de 34 bits: el firmware manda los 32 bits completos y las tarjetas
# se dieron de alta con su número impreso (24 bits bajos).
FULL = 919148043          # 0x36C9160B, lo que manda el ZK-QR-500 con Wiegand 34
LOW24 = FULL & 0xFFFFFF   # 13178379, número impreso


def test_card_with_printed_24_bits_opens_with_full_code(conn, host):
    add_card(conn, LOW24, host)
    out = read(conn, 0, code=FULL)
    log = last_log(conn)
    assert out.allowed and log["source"] == 0 and log["code"] == LOW24


def test_full_code_card_has_priority_over_24_bits(conn, host):
    other = add_holder(conn, "Beto", "persona")
    add_card(conn, LOW24, other)
    add_card(conn, FULL, host)
    out = read(conn, 0, code=FULL)
    log = last_log(conn)
    assert out.allowed and log["code"] == FULL and log["holder_id"] == host


def test_qr_full_code_wins_over_24_bit_card(conn, host):
    # El QR va primero: si el código completo es el de un QR vivo y sus 24 bits bajos son el de una tarjeta,
    # abre como QR (consume un uso), no como tarjeta.
    add_card(conn, LOW24, host)
    add_qr(conn, host, code=FULL)
    out = read(conn, 0, code=FULL)
    assert out.allowed and last_log(conn)["source"] == 7 and uses(conn)[0][0] == 1


def test_unknown_full_code_without_24_bit_match_is_1(conn, host):
    code = 0x12C9160B  # fuera del rango de QR
    out = read(conn, 0, code=code)
    assert out.reason == 1 and last_log(conn)["code"] == code


def test_24_bit_card_in_reader_without_card_is_17(conn, host):
    add_card(conn, LOW24, host)
    assert read(conn, 1, code=FULL).reason == 17


def test_code_up_to_24_bits_unchanged(conn, host):
    add_card(conn, LOW24, host)
    assert read(conn, 0, code=LOW24).allowed
    assert read(conn, 0, code=LOW24 + 1).reason == 1
