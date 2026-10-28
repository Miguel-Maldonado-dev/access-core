"""Traducción entre las tablas locales y la forma del contrato de la nube.

En el contrato las referencias van por UUID (`holder_id`, `control_id`); `permission_id`
(0..31) y `output_id` (0..3) viajan tal cual. Localmente las llaves son enteros, así que
aquí se traduce UUID <-> ID local y se asignan IDs locales nuevos al dar de alta.

`apply_batch` aplica cambios de la nube (pull, `current` del push, reconcile y adopción) en una
sola transacción con `sync_guard.applying=1`: no entran a la bandeja (Riesgo 1).
El PIN viaja en claro en `data`: nunca se registra ni se incluye en los mensajes de error.
"""
import logging
import sqlite3
import uuid as uuidlib
from collections import OrderedDict
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Tuple

from acceso.cloud.identity import set_state
from acceso.constants import REPLICATED_TABLES
from acceso.db import now_ms

log = logging.getLogger("acceso.cloud")

# Las altas van de padres a hijos y después los borrados de hijos a padres (ver _Applier).
# `outputs` no se borra: las 4 salidas son fijas en el panel.
DELETE_ORDER = ("control_buttons", "cards", "holder_permissions", "controls", "holders", "permissions")
UPSERT_ORDER = ("holders", "permissions", "outputs", "controls", "cards", "control_buttons",
                "holder_permissions")

# Columnas de `data` por tabla, como `dataSchemas` de cloud/src/lib/device/contract.ts.
FIELDS = {
    "holders": ("kind", "name", "department", "address", "notes", "pin"),
    "cards": ("card_code", "holder_id", "description"),
    "controls": ("holder_id", "description"),
    "control_buttons": ("control_id", "button", "rf_code", "output_id"),
    "permissions": ("permission_id", "name", "output_mask", "card_reader_mask", "pin_reader_mask",
                    "allow_rf", "weekday_mask", "start_minute", "end_minute"),
    "holder_permissions": ("holder_id", "permission_id"),
    "outputs": ("output_id", "alias", "duration_ms", "reader_mask", "enabled"),
}

# Cada registro vivo en la forma del contrato (`id` = uuid). Las referencias se traducen a UUID.
_SELECT = {
    "holders": "SELECT h.uuid AS id, h.kind, h.name, h.department, h.address, h.notes, h.pin"
               " FROM holders h",
    "cards": "SELECT c.uuid AS id, c.card_code, h.uuid AS holder_id, c.description"
             " FROM cards c JOIN holders h ON h.holder_id = c.holder_id",
    "controls": "SELECT k.uuid AS id, h.uuid AS holder_id, k.description"
                " FROM controls k JOIN holders h ON h.holder_id = k.holder_id",
    "control_buttons": "SELECT b.uuid AS id, k.uuid AS control_id, b.button, b.rf_code, b.output_id"
                       " FROM control_buttons b JOIN controls k ON k.control_id = b.control_id",
    "permissions": "SELECT p.uuid AS id, p.permission_id, p.name, p.output_mask, p.card_reader_mask,"
                   " p.pin_reader_mask, p.allow_rf, p.weekday_mask, p.start_minute, p.end_minute"
                   " FROM permissions p",
    "holder_permissions": "SELECT hp.uuid AS id, h.uuid AS holder_id, hp.permission_id"
                          " FROM holder_permissions hp JOIN holders h ON h.holder_id = hp.holder_id",
    "outputs": "SELECT o.uuid AS id, o.output_id, o.alias, o.duration_ms, o.reader_mask, o.enabled"
               " FROM outputs o",
}
_ALIAS = {"holders": "h", "cards": "c", "controls": "k", "control_buttons": "b", "permissions": "p",
          "holder_permissions": "hp", "outputs": "o"}
_BOOLEANS = ("allow_rf", "enabled")


class MissingParent(Exception):
    """El registro apunta a otro que no existe en el panel (`uuid` es None si la referencia es un
    `permission_id`)."""

    def __init__(self, table: str, uuid: Optional[str] = None):
        super().__init__(table)
        self.table = table
        self.uuid = uuid


class InvalidChange(ValueError):
    """Un cambio de la nube que el panel no puede aplicar. Se aborta el lote (el cursor no avanza)."""


def _unknown_table(table: Any) -> str:
    return "La nube envió un cambio de una tabla desconocida: %s." % str(table)[:40]


def _data(row: sqlite3.Row, table: str) -> Dict[str, Any]:
    data = {key: row[key] for key in FIELDS[table]}
    for key in _BOOLEANS:
        if key in data:
            data[key] = bool(data[key])
    return data


def row_to_data(conn: sqlite3.Connection, table: str, uuid: str) -> Optional[Dict[str, Any]]:
    """`data` del contrato del registro con ese UUID; None si ya no existe."""
    row = conn.execute(_SELECT[table] + " WHERE %s.uuid = ?" % _ALIAS[table], (uuid,)).fetchone()
    return None if row is None else _data(row, table)


def snapshot_tables(conn: sqlite3.Connection) -> Dict[str, List[Dict[str, Any]]]:
    """Todas las tablas replicadas como `{tabla: [{id, data}]}`, ordenadas por id."""
    return {
        table: [{"id": row["id"], "data": _data(row, table)}
                for row in conn.execute(_SELECT[table] + " ORDER BY id")]
        for table in REPLICATED_TABLES
    }


# --- aplicar cambios de la nube -------------------------------------------------------------------

def _local_id(conn: sqlite3.Connection, table: str, key: str, uuid: Any) -> int:
    row = conn.execute("SELECT %s FROM %s WHERE uuid = ?" % (key, table), (uuid,)).fetchone()
    if row is None:
        raise MissingParent(table, uuid)
    return row[0]


def _fields(table: str, data: Any) -> Dict[str, Any]:
    if not isinstance(data, Mapping) or any(key not in data for key in FIELDS[table]):
        raise InvalidChange("La nube envió un cambio incompleto de %s." % table)
    return {key: data[key] for key in FIELDS[table]}


def _exists(conn: sqlite3.Connection, table: str, uuid: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM %s WHERE uuid = ?" % table, (uuid,)).fetchone()


# Lo llama la liberación de una llave única con el UUID de cada fila local que la ocupa, antes de
# liberarla: `apply_changes` aplica ahí la versión de la nube de esa fila si viene en el lote.
Resolver = Callable[[str, str], None]


def _release(conn: sqlite3.Connection, table: str, where: str, params: Tuple[Any, ...], uuid: str,
             resolve: Optional[Resolver]) -> None:
    if resolve is None:
        return
    others = conn.execute("SELECT uuid FROM %s WHERE (%s) AND uuid <> ?" % (table, where),
                          params + (uuid,)).fetchall()
    for (other,) in others:
        resolve(table, other)


def _upsert_holder(conn: sqlite3.Connection, uuid: str, d: Dict[str, Any], stamp: int,
                   resolve: Optional[Resolver]) -> None:
    if d["pin"] is not None:
        _release(conn, "holders", "pin = ?", (d["pin"],), uuid, resolve)
        # Otro titular con ese PIN pierde solo el PIN (no se borra con sus tarjetas): si sigue vivo
        # en la nube con otro PIN, ya se aplicó su versión del lote.
        conn.execute("UPDATE holders SET pin = NULL WHERE pin = ? AND uuid <> ?", (d["pin"], uuid))
    values = (d["kind"], d["name"], d["department"], d["address"], d["notes"], d["pin"], stamp)
    if _exists(conn, "holders", uuid):
        conn.execute("UPDATE holders SET kind=?, name=?, department=?, address=?, notes=?, pin=?,"
                     " updated_at=?, origin='cloud' WHERE uuid=?", values + (uuid,))
    else:
        conn.execute("INSERT INTO holders(kind, name, department, address, notes, pin, updated_at,"
                     " origin, uuid) VALUES (?, ?, ?, ?, ?, ?, ?, 'cloud', ?)", values + (uuid,))


def _upsert_permission(conn: sqlite3.Connection, uuid: str, d: Dict[str, Any], stamp: int,
                       resolve: Optional[Resolver]) -> None:
    pid = d["permission_id"]
    _release(conn, "permissions", "permission_id = ?", (pid,), uuid, resolve)
    conn.execute("DELETE FROM permissions WHERE permission_id = ? AND uuid <> ?", (pid, uuid))
    values = (pid, d["name"], d["output_mask"], d["card_reader_mask"], d["pin_reader_mask"],
              1 if d["allow_rf"] else 0, d["weekday_mask"], d["start_minute"], d["end_minute"], stamp)
    current = _exists(conn, "permissions", uuid)
    if current is not None:
        if current["permission_id"] != pid:
            # Sin ON UPDATE CASCADE: las asignaciones siguen al permiso.
            conn.execute("UPDATE holder_permissions SET permission_id = ? WHERE permission_id = ?",
                         (pid, current["permission_id"]))
        conn.execute("UPDATE permissions SET permission_id=?, name=?, output_mask=?, card_reader_mask=?,"
                     " pin_reader_mask=?, allow_rf=?, weekday_mask=?, start_minute=?, end_minute=?,"
                     " updated_at=?, origin='cloud' WHERE uuid=?", values + (uuid,))
    else:
        conn.execute("INSERT INTO permissions(permission_id, name, output_mask, card_reader_mask,"
                     " pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute, updated_at,"
                     " origin, uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cloud', ?)", values + (uuid,))


def _upsert_output(conn: sqlite3.Connection, uuid: str, d: Dict[str, Any], stamp: int,
                   resolve: Optional[Resolver]) -> None:
    oid = d["output_id"]
    # El UUID se mueve a esta salida si otra lo tenía (no debería pasar).
    conn.execute("UPDATE outputs SET uuid = ? WHERE uuid = ? AND output_id <> ?",
                 (str(uuidlib.uuid4()), uuid, oid))
    values = (d["duration_ms"], d["reader_mask"], 1 if d["enabled"] else 0, d["alias"], uuid, stamp)
    cur = conn.execute("UPDATE outputs SET duration_ms=?, reader_mask=?, enabled=?, alias=?, uuid=?,"
                       " updated_at=?, origin='cloud' WHERE output_id=?", values + (oid,))
    if cur.rowcount == 0:
        conn.execute("INSERT INTO outputs(duration_ms, reader_mask, enabled, alias, uuid, updated_at,"
                     " origin, output_id) VALUES (?, ?, ?, ?, ?, ?, 'cloud', ?)", values + (oid,))


def _upsert_control(conn: sqlite3.Connection, uuid: str, d: Dict[str, Any], stamp: int,
                    resolve: Optional[Resolver]) -> None:
    values = (_local_id(conn, "holders", "holder_id", d["holder_id"]), d["description"], stamp)
    if _exists(conn, "controls", uuid):
        conn.execute("UPDATE controls SET holder_id=?, description=?, updated_at=?, origin='cloud'"
                     " WHERE uuid=?", values + (uuid,))
    else:
        conn.execute("INSERT INTO controls(holder_id, description, updated_at, origin, uuid)"
                     " VALUES (?, ?, ?, 'cloud', ?)", values + (uuid,))


def _upsert_card(conn: sqlite3.Connection, uuid: str, d: Dict[str, Any], stamp: int,
                 resolve: Optional[Resolver]) -> None:
    holder_id = _local_id(conn, "holders", "holder_id", d["holder_id"])
    _release(conn, "cards", "card_code = ?", (d["card_code"],), uuid, resolve)
    conn.execute("DELETE FROM cards WHERE card_code = ? AND uuid <> ?", (d["card_code"], uuid))
    values = (d["card_code"], holder_id, d["description"], stamp)
    if _exists(conn, "cards", uuid):
        conn.execute("UPDATE cards SET card_code=?, holder_id=?, description=?, updated_at=?,"
                     " origin='cloud' WHERE uuid=?", values + (uuid,))
    else:
        conn.execute("INSERT INTO cards(card_code, holder_id, description, updated_at, origin, uuid)"
                     " VALUES (?, ?, ?, ?, 'cloud', ?)", values + (uuid,))


def _upsert_button(conn: sqlite3.Connection, uuid: str, d: Dict[str, Any], stamp: int,
                   resolve: Optional[Resolver]) -> None:
    control_id = _local_id(conn, "controls", "control_id", d["control_id"])
    _release(conn, "control_buttons", "rf_code = ? OR (control_id = ? AND button = ?)",
             (d["rf_code"], control_id, d["button"]), uuid, resolve)
    conn.execute("DELETE FROM control_buttons WHERE (rf_code = ? OR (control_id = ? AND button = ?))"
                 " AND uuid <> ?", (d["rf_code"], control_id, d["button"], uuid))
    values = (control_id, d["button"], d["rf_code"], d["output_id"], stamp)
    if _exists(conn, "control_buttons", uuid):
        conn.execute("UPDATE control_buttons SET control_id=?, button=?, rf_code=?, output_id=?,"
                     " updated_at=?, origin='cloud' WHERE uuid=?", values + (uuid,))
    else:
        conn.execute("INSERT INTO control_buttons(control_id, button, rf_code, output_id, updated_at,"
                     " origin, uuid) VALUES (?, ?, ?, ?, ?, 'cloud', ?)", values + (uuid,))


def _upsert_holder_permission(conn: sqlite3.Connection, uuid: str, d: Dict[str, Any], stamp: int,
                              resolve: Optional[Resolver]) -> None:
    holder_id = _local_id(conn, "holders", "holder_id", d["holder_id"])
    pid = d["permission_id"]
    if conn.execute("SELECT 1 FROM permissions WHERE permission_id = ?", (pid,)).fetchone() is None:
        raise MissingParent("permissions")
    _release(conn, "holder_permissions", "holder_id = ? AND permission_id = ?", (holder_id, pid), uuid,
             resolve)
    conn.execute("DELETE FROM holder_permissions WHERE holder_id = ? AND permission_id = ? AND uuid <> ?",
                 (holder_id, pid, uuid))
    values = (holder_id, pid, stamp)
    if _exists(conn, "holder_permissions", uuid):
        conn.execute("UPDATE holder_permissions SET holder_id=?, permission_id=?, updated_at=?,"
                     " origin='cloud' WHERE uuid=?", values + (uuid,))
    else:
        conn.execute("INSERT INTO holder_permissions(holder_id, permission_id, updated_at, origin, uuid)"
                     " VALUES (?, ?, ?, 'cloud', ?)", values + (uuid,))


_UPSERT = {
    "holders": _upsert_holder,
    "permissions": _upsert_permission,
    "outputs": _upsert_output,
    "controls": _upsert_control,
    "cards": _upsert_card,
    "control_buttons": _upsert_button,
    "holder_permissions": _upsert_holder_permission,
}


def apply_upsert(conn: sqlite3.Connection, table: str, uuid: str, data: Mapping[str, Any], *,
                 resolve: Optional[Resolver] = None) -> None:
    """Alta o cambio de un registro de la nube. Una llave única que tiene otra fila local (otro
    UUID) se libera antes: la nube es la referencia (con `resolve`, primero se le avisa con el UUID
    de esa fila). Lanza MissingParent si falta el padre."""
    if table not in _UPSERT:
        raise InvalidChange(_unknown_table(table))
    _UPSERT[table](conn, uuid, _fields(table, data), now_ms(), resolve)


def apply_delete(conn: sqlite3.Connection, table: str, uuid: str) -> None:
    """Borrado real (con sus cascadas). Un UUID que no existe no hace nada; outputs no se borra."""
    if table not in REPLICATED_TABLES:
        raise InvalidChange(_unknown_table(table))
    if table != "outputs":
        conn.execute("DELETE FROM %s WHERE uuid = ?" % table, (uuid,))


def collapse(changes: Iterable[Mapping[str, Any]]) -> "OrderedDict[Tuple[str, str], Mapping[str, Any]]":
    """El último cambio de cada registro, en el orden en que llegaron (por revisión)."""
    last = OrderedDict()  # type: OrderedDict[Tuple[str, str], Mapping[str, Any]]
    for change in changes:
        key = (change["table"], change["id"])
        last.pop(key, None)
        last[key] = change
    return last


@contextmanager
def applying(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Transacción del agente: BEGIN IMMEDIATE, FK diferidas y la guarda en 1; la guarda vuelve a 0
    antes del COMMIT (y con el ROLLBACK si algo falla)."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("PRAGMA defer_foreign_keys=ON")
        conn.execute("UPDATE sync_guard SET applying=1 WHERE id=1")
        yield conn
        conn.execute("UPDATE sync_guard SET applying=0 WHERE id=1")
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


# Hijos que un borrado arrastra en cascada: (tabla padre, su llave) -> [(tabla hija, columna)].
_CHILDREN = {
    "holders": ("holder_id", (("cards", "holder_id"), ("controls", "holder_id"),
                              ("holder_permissions", "holder_id"))),
    "controls": ("control_id", (("control_buttons", "control_id"),)),
    "permissions": ("permission_id", (("holder_permissions", "permission_id"),)),
}

DISCARDED_MESSAGE = ("Se descartaron cambios locales de %d registro(s): la nube ya los había cambiado o"
                     " borrado (tarjeta, código RF, PIN, permiso o titular). Quedó la versión de la nube.")


class _Applier:
    """Aplica un lote colapsado: primero las altas y cambios (padres a hijos), después los borrados
    (hijos a padres).

    Las altas van primero para que un hijo que la nube pasó a otro padre ya no apunte al padre
    que se borra: ninguna cascada local borra una fila que la nube conserva (los hijos sin cambios
    no vienen en el lote). Los choques de llaves únicas los resuelve la liberación de llaves.
    Si una liberación o una cascada alcanza una fila con cambios pendientes en la bandeja, gana la
    nube: se aplica su versión del lote (o se libera la llave) y se quitan sus entradas. Los
    borrados nunca se adelantan a la fase de borrados. Una alta cuyo padre falta aborta el lote,
    salvo que el padre falte por un borrado local que aún no se sube. Con `force_deletes` (pull),
    un borrado de la nube se aplica aunque la fila tenga cambios pendientes, y se quitan sus
    entradas de la bandeja.
    """

    def __init__(self, conn: sqlite3.Connection, changes: Iterable[Mapping[str, Any]], keep_pending: bool,
                 skip_missing_parents: bool = False, force_deletes: bool = False):
        self.conn = conn
        self.skip_missing_parents = skip_missing_parents
        self.force_deletes = force_deletes
        self.todo = collapse(changes)
        for (table, _), change in self.todo.items():
            if table not in REPLICATED_TABLES:
                raise InvalidChange(_unknown_table(table))
            if change["op"] not in ("upsert", "delete"):
                raise InvalidChange("La nube envió una operación desconocida en %s." % table)
        self.pending = set()  # type: set
        if keep_pending:
            self.pending = {r[0] for r in conn.execute("SELECT DISTINCT row_uuid FROM sync_outbox")}
        self.done = set()  # type: set
        self.skipped = set()  # type: set
        self.applied = 0
        self.discarded = 0

    def run(self) -> int:
        for table in UPSERT_ORDER:
            for (t, _), change in list(self.todo.items()):
                if t == table and change["op"] == "upsert":
                    self.apply(change)
        for table in DELETE_ORDER:
            for (t, _), change in list(self.todo.items()):
                if t == table and change["op"] == "delete":
                    self.apply(change)
        for (table, row_id), change in self.todo.items():
            if table == "outputs" and change["op"] == "delete":
                log.warning("Se ignoró el borrado de la salida %s: las salidas del panel son fijas", row_id)
        if self.discarded:
            set_state(self.conn, "last_error", DISCARDED_MESSAGE % self.discarded)
        return self.applied

    def apply(self, change: Mapping[str, Any], force: bool = False) -> None:
        key = (change["table"], change["id"])
        if key in self.done:
            return
        if change["id"] in self.pending and not force:
            if not (change["op"] == "delete" and self.force_deletes):
                return
            self._drop_pending(change["id"])
        self.done.add(key)
        table, row_id = key
        if change["op"] == "delete":
            if table in _CHILDREN:
                self._resolve_children(table, row_id)
            apply_delete(self.conn, table, row_id)
            self.applied += 1
            return
        try:
            apply_upsert(self.conn, table, row_id, change.get("data"), resolve=self.resolve)
            self.applied += 1
        except MissingParent as missing:
            if self.skip_missing_parents:
                # `current` del push: el padre aún no se descarga; el pull siguiente trae los dos.
                self.skipped.add((table, row_id))
                log.warning("Se omitió la versión de la nube de %s %s: su registro de %s aún no está"
                            " en el panel; llegará con el siguiente pull", table, row_id, missing.table)
                return
            if not self._parent_pending_delete(missing):
                # Nunca se omite en silencio una fila que la nube conserva: se aborta el lote.
                raise InvalidChange(
                    "La nube envió un registro de %s que apunta a otro de %s que no existe en el panel."
                    % (table, missing.table)) from None
            self.skipped.add((table, row_id))
            log.warning("Se omitió %s %s: su registro de %s se borró en el panel y el borrado aún"
                        " no se sube", table, row_id, missing.table)

    def _parent_pending_delete(self, missing: MissingParent) -> bool:
        """El padre falta porque el panel lo borró y el borrado sigue en la bandeja (o porque el
        padre mismo se omitió por eso): al subir el borrado, la nube resuelve."""
        if missing.uuid is None:  # permission_id
            return self.conn.execute("SELECT 1 FROM sync_outbox WHERE table_name = ? AND op = 'delete'",
                                     (missing.table,)).fetchone() is not None
        if (missing.table, missing.uuid) in self.skipped:
            return True
        return self.conn.execute("SELECT 1 FROM sync_outbox WHERE table_name = ? AND op = 'delete'"
                                 " AND row_uuid = ?", (missing.table, missing.uuid)).fetchone() is not None

    def _drop_pending(self, row_id: str) -> None:
        """La nube gana sobre esta fila: se quitan sus cambios pendientes de la bandeja."""
        if row_id in self.pending:
            self.conn.execute("DELETE FROM sync_outbox WHERE row_uuid = ?", (row_id,))
            self.pending.discard(row_id)
            self.discarded += 1

    def resolve(self, table: str, row_id: str) -> None:
        """La nube manda sobre esta fila: quita sus cambios pendientes y, si el lote trae un alta o
        cambio suyo, lo aplica ya. Un borrado del lote se queda en la fase de borrados: aplicarlo
        aquí arrastraría en cascada hijos que la nube pasa a un padre que aún no existe."""
        self._drop_pending(row_id)
        change = self.todo.get((table, row_id))
        if change is not None and change["op"] == "upsert":
            self.apply(change, force=True)

    def _resolve_children(self, table: str, row_id: str) -> None:
        """Antes de borrar un padre, sus hijos con cambios en el lote (aunque estén pendientes) se
        aplican: un hijo que la nube movió a otro padre no se va en la cascada."""
        key, children = _CHILDREN[table]
        for child, column in children:
            rows = self.conn.execute(
                "SELECT c.uuid FROM %s c JOIN %s p ON p.%s = c.%s WHERE p.uuid = ?"
                % (child, table, key, column), (row_id,)).fetchall()
            for (child_id,) in rows:
                if (child, child_id) in self.todo:
                    self.resolve(child, child_id)


def apply_changes(conn: sqlite3.Connection, changes: Iterable[Mapping[str, Any]], *,
                  keep_pending: bool = True, skip_missing_parents: bool = False,
                  force_deletes: bool = False) -> int:
    """Aplica cambios `{table, op, id, data?}` dentro de una transacción ya abierta con `applying`.

    Con `keep_pending`, un registro con cambios locales aún en la bandeja no se toca: al subirlos,
    la nube decide y responde con `current` (salvo que la nube le quite una llave única o lo mueva
    de un padre que borra: ahí gana la nube y `last_error` lo dice). Devuelve cuántos se aplicaron.

    Una alta cuyo padre falta aborta el lote (pull, reconcile, adopción). Con
    `skip_missing_parents` (los `current` del push) se omite: la fila local queda como está y el
    pull siguiente la trae con su padre.

    Con `force_deletes` (el pull), los borrados se aplican aunque la fila esté pendiente: una
    revocación hecha en la nube llega aunque el push de esa fila falle.
    """
    return _Applier(conn, changes, keep_pending, skip_missing_parents, force_deletes).run()


def apply_batch(conn: sqlite3.Connection, changes: Iterable[Mapping[str, Any]], *,
                keep_pending: bool = True, state: Optional[Mapping[str, str]] = None,
                check: Optional[Callable[[sqlite3.Connection], None]] = None,
                force_deletes: bool = False) -> int:
    """Aplica un lote de la nube en una sola transacción; `state` se guarda en `sync_state` en la
    misma transacción (p. ej. el cursor del pull). `check` corre dentro de la transacción antes
    de aplicar: si lanza, no se aplica nada."""
    with applying(conn):
        if check is not None:
            check(conn)
        applied = apply_changes(conn, changes, keep_pending=keep_pending, force_deletes=force_deletes)
        for key, value in (state or {}).items():
            set_state(conn, key, value)
    return applied
