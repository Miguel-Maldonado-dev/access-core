import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


def connect(db_path: Path, *, check_same_thread: bool = True) -> sqlite3.Connection:
    """Abre la base en modo autocommit; las transacciones son siempre explicitas."""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(db_path), isolation_level=None, check_same_thread=check_same_thread
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def now_ms() -> int:
    """Milisegundos desde la época: la marca updated_at de los registros replicados."""
    return int(time.time() * 1000)


@contextmanager
def transaction(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
