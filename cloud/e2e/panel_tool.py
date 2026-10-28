"""Ayudas del lado del panel para cloud/e2e/run_e2e.sh.

Se ejecuta con el Python del panel (panel/backend/.venv) y SIEMPRE sobre una base temporal
creada por el propio script: nunca toca panel/backend/data ni /etc/acceso.

Subcomandos (la salida es una sola línea de JSON o un número):
  init <db>                          migra a v6, crea 1 titular con 1 tarjeta y la identidad.
  add-card <db> <código>             alta de tarjeta con la capa `store` (genera bandeja).
  add-log <db> <código>              inserta un log de acceso (como el daemon) y devuelve su id.
  measure-push <db> <cred> <url> <n> alta de n tarjetas y tiempo de un push (SyncEngine).
  measure-pull <db> <cred> <url> <n> tiempo de un pull; exige que lleguen n tarjetas nuevas.
"""
import json
import sys
import time
from contextlib import closing
from pathlib import Path

from acceso.cloud.api import CloudApi
from acceso.cloud.config import load_credentials
from acceso.cloud.identity import ensure_identity
from acceso.cloud.sync import SyncEngine
from acceso.constants import SOURCE_CARD, REASON_ALLOWED
from acceso.db import connect
from acceso.logs import HolderRef, append_log
from acceso.migrate import migrate
from acceso.store import cards, holders
from acceso.store.holders import HolderData

INITIAL_CARD = 4000000001
BATCH_BASE = 3000000000  # códigos de las tarjetas de la medición de lotes


def _first_holder(conn):
    row = conn.execute("SELECT holder_id, name, kind FROM holders ORDER BY holder_id LIMIT 1").fetchone()
    if row is None:
        raise SystemExit("La base no tiene titulares")
    return row


def init(db):
    migrate(Path(db))
    with closing(connect(Path(db))) as conn:
        holder_id = holders.create_holder(conn, HolderData(kind="persona", name="Titular E2E",
                                                           department="101"))
        cards.create_card(conn, INITIAL_CARD, holder_id, "Tarjeta inicial E2E")
        identity = ensure_identity(conn)
        uuid = conn.execute("SELECT uuid FROM holders WHERE holder_id=?", (holder_id,)).fetchone()[0]
    print(json.dumps({"panel_code": identity.panel_code, "claim_code": identity.claim_code,
                      "holder_uuid": uuid, "card_code": INITIAL_CARD}))


def add_card(db, code):
    with closing(connect(Path(db))) as conn:
        cards.create_card(conn, int(code), _first_holder(conn)["holder_id"], "Tarjeta E2E del panel")
    print(json.dumps({"card_code": int(code)}))


def add_log(db, code):
    with closing(connect(Path(db))) as conn:
        holder = _first_holder(conn)
        log_id = append_log(conn, timestamp=int(time.time()), allowed=True, source=SOURCE_CARD,
                            reason=REASON_ALLOWED,
                            holder=HolderRef(holder["holder_id"], holder["name"], holder["kind"]),
                            credential_label="Tarjeta E2E", code=int(code), output_id=0,
                            max_entries=100000)
    print(json.dumps({"log_id": log_id}))


def _engine(db, credentials, url):
    creds = load_credentials(credentials)
    if creds is None:
        raise SystemExit("No hay credenciales del agente en %s" % credentials)
    api = CloudApi(url)
    api.authenticate(*creds)
    return api, SyncEngine(Path(db), api)


def measure_push(db, credentials, url, n):
    api, engine = _engine(db, credentials, url)
    try:
        engine.push()  # vacía la bandeja: solo se mide el lote nuevo
        with closing(connect(Path(db))) as conn:
            holder_id = _first_holder(conn)["holder_id"]
            for i in range(n):
                cards.create_card(conn, BATCH_BASE + i, holder_id, "Lote E2E")
            pending = conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0]
        start = time.perf_counter()
        sent = engine.push()
        elapsed = time.perf_counter() - start
    finally:
        api.close()
    print(json.dumps({"pending": pending, "sent": sent, "seconds": round(elapsed, 3)}))


def measure_pull(db, credentials, url, n):
    api, engine = _engine(db, credentials, url)
    try:
        with closing(connect(Path(db))) as conn:
            before = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
        start = time.perf_counter()
        engine.pull()
        elapsed = time.perf_counter() - start
        with closing(connect(Path(db))) as conn:
            after = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    finally:
        api.close()
    print(json.dumps({"new_cards": after - before, "expected": n, "seconds": round(elapsed, 3)}))
    if after - before != n:
        raise SystemExit("El pull trajo %d tarjetas nuevas y se esperaban %d" % (after - before, n))


COMMANDS = {"init": (init, 1), "add-card": (add_card, 2), "add-log": (add_log, 2),
            "measure-push": (measure_push, 4), "measure-pull": (measure_pull, 4)}


def main(argv):
    if len(argv) < 2 or argv[1] not in COMMANDS:
        raise SystemExit(__doc__)
    func, arity = COMMANDS[argv[1]]
    args = argv[2:]
    if len(args) != arity:
        raise SystemExit("Uso: panel_tool.py %s (%d argumentos)" % (argv[1], arity))
    if argv[1].startswith("measure"):
        args[3] = int(args[3])
    func(*args)


if __name__ == "__main__":
    main(sys.argv)
