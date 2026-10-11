import sqlite3
from typing import Iterator

from fastapi import Request

from acceso.db import connect


def get_conn(request: Request) -> Iterator[sqlite3.Connection]:
    # Una conexión por petición, usada en serie: seguro entre hilos del pool.
    conn = connect(request.app.state.settings.db_path, check_same_thread=False)
    try:
        yield conn
    finally:
        conn.close()
