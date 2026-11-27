from datetime import datetime

from acceso.logs import append_log, delete_logs_until, purge_old_logs

NOW = datetime(2026, 11, 9, 12, 0).timestamp()
DAY = 86400


def add(conn, ts):
    append_log(conn, timestamp=int(ts), allowed=True, source=1, reason=0, max_entries=1000)


def stamps(conn):
    return [r[0] for r in conn.execute("SELECT timestamp FROM access_logs ORDER BY timestamp")]


def test_purge_old_logs_deletes_older_than_30_days(conn):
    add(conn, NOW - 31 * DAY)
    add(conn, NOW - 29 * DAY)
    assert purge_old_logs(conn, NOW) == 1
    assert stamps(conn) == [int(NOW - 29 * DAY)]


def test_purge_old_logs_skips_without_clock(conn):
    add(conn, 100)
    assert purge_old_logs(conn, 1000) == 0
    assert stamps(conn) == [100]


def test_delete_logs_until_inclusive(conn):
    for ts in (100, 200, 300):
        add(conn, ts)
    assert delete_logs_until(conn, 200) == 2
    assert stamps(conn) == [300]


def test_append_log_qr_use_counts_in_same_transaction(conn):
    from helpers import add_holder, stamp
    holder_id = add_holder(conn)
    qr_id = conn.execute(
        "INSERT INTO qr_codes(holder_id, code, valid_from, valid_until, created_at, uuid,"
        " updated_at, origin) VALUES (?, 912345678, 1, 2, 1, ?, ?, ?)",
        (holder_id,) + stamp()).lastrowid
    for _ in range(2):
        append_log(conn, timestamp=1, allowed=True, source=7, reason=0, max_entries=1000,
                   qr_use=(qr_id, 1))
    assert conn.execute("SELECT count FROM qr_uses WHERE qr_id=? AND reader=1",
                        (qr_id,)).fetchone()[0] == 2
    assert not conn.in_transaction
