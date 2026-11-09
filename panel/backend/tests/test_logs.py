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
