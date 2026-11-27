import uuid

import pytest

from acceso.qr import QrCodeExhausted, QrSettings, generate_code, get_qr_settings, looks_like_qr, qr_range


def seq(values):
    it = iter(values)
    return lambda lo, hi: next(it)


@pytest.mark.parametrize("d,lo,hi", [(1, 1000000000, 1999999999), (3, 3000000000, 3999999999),
                                     (4, 4000000000, 4294967295), (5, 500000000, 599999999),
                                     (9, 900000000, 999999999)])
def test_qr_range(d, lo, hi):
    assert qr_range(d) == (lo, hi)


def test_looks_like_qr():
    assert looks_like_qr(912345678, 9)
    assert not looks_like_qr(12345678, 9)
    assert not looks_like_qr(9123456789, 9)


def test_generate_skips_taken_card(conn):
    conn.execute("INSERT INTO holders(holder_id, kind, name, uuid, updated_at)"
                 " VALUES (1, 'persona', 'Ana', ?, 1)", (str(uuid.uuid4()),))
    conn.execute("INSERT INTO cards(card_code, holder_id, uuid, updated_at) VALUES (900000001, 1, ?, 1)",
                 (str(uuid.uuid4()),))
    assert generate_code(conn, 9, rand=seq([900000001, 900000002])) == 900000002


def test_generate_skips_taken_qr(conn):
    conn.execute("INSERT INTO holders(holder_id, kind, name, uuid, updated_at)"
                 " VALUES (1, 'persona', 'Ana', ?, 1)", (str(uuid.uuid4()),))
    conn.execute("INSERT INTO qr_codes(holder_id, code, valid_from, valid_until, created_at, uuid, updated_at)"
                 " VALUES (1, 900000001, 1, 2, 1, ?, 1)", (str(uuid.uuid4()),))
    assert generate_code(conn, 9, rand=seq([900000001, 900000003])) == 900000003


def test_generate_default_rand_in_range(conn):
    code = generate_code(conn, 9)
    assert 900000000 <= code <= 999999999


def test_generate_exhausted(conn):
    conn.execute("INSERT INTO holders(holder_id, kind, name, uuid, updated_at)"
                 " VALUES (1, 'persona', 'Ana', ?, 1)", (str(uuid.uuid4()),))
    conn.execute("INSERT INTO cards(card_code, holder_id, uuid, updated_at) VALUES (900000001, 1, ?, 1)",
                 (str(uuid.uuid4()),))
    with pytest.raises(QrCodeExhausted):
        generate_code(conn, 9, rand=lambda lo, hi: 900000001)


def test_get_qr_settings(conn):
    assert get_qr_settings(conn) == QrSettings(digit=9, max_active=1000)
