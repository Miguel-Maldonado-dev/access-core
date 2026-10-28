"""Motor de sincronización del agente acceso-cloud: subida (push), bajada (pull), logs,
reconciliación por checksums y adopción de los datos de la nube.

Cada operación abre su propia conexión y escribe con transacciones cortas `BEGIN IMMEDIATE`
(la web local y el daemon esperan como mucho el `busy_timeout`). Lo que llega de la nube se
aplica con `sync_guard.applying=1`, así que no vuelve a la bandeja. El PIN viaja en claro solo
dentro del contrato hacia y desde la nube: nunca en logs, excepciones ni `last_error`.
"""
import logging
import os
import sqlite3
import time
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple, Union

from acceso.cloud.api import CloudApi, CloudError
from acceso.cloud.checksum import table_checksum
from acceso.cloud.identity import get_state, set_state
from acceso.cloud.mapping import (
    apply_batch, apply_changes, applying, collapse, row_to_data, snapshot_tables,
)
from acceso.constants import REPLICATED_TABLES, SOURCE_PIN
from acceso.db import connect, now_ms, transaction
from acceso.migrate import MAX_DATED_BACKUPS

log = logging.getLogger("acceso.cloud")

CHANGES_PAGE = 500
LOG_BATCH = 500
MASS_DELETE_RATIO = 0.20
MASS_DELETE_MIN = 10  # con menos borrados nunca se bloquea

# Tablas protegidas contra borrados masivos (y su nombre para los mensajes).
GUARDED_TABLES = (("holders", "titulares"), ("cards", "tarjetas"))
# Rechazo de la nube cuyo `current` no se aplica: el cambio se reintenta en el siguiente ciclo.
RELATED_MISSING = "relacionado no existe"
# Rechazo por llave única. En el alta de un titular es su PIN: se quita el PIN y se reintenta.
DUPLICATE = "duplicado"
DUPLICATE_PIN_MESSAGE = ("La nube rechazó el titular nuevo «%s»: su PIN ya lo usa otro titular. Se quitó el"
                         " PIN en el panel y el titular se sube sin PIN; asígnale otro.")
_NAME_MAX = 60
# Marca de que la adopción en curso ya respaldó la base (los reintentos no vuelven a copiarla).
ADOPT_BACKUP_KEY = "adopt_backup_done"
_TEXT_MAX = 1000  # holder_name y credential_label en POST /logs
_REASON_MAX = 200


class SyncBlocked(Exception):
    """La nube borraría demasiados registros de una tabla y nadie confirmó los borrados."""

    def __init__(self, table: str, would_delete: int, total: int):
        self.table = table
        self.would_delete = would_delete
        self.total = total
        label = dict(GUARDED_TABLES).get(table, table)
        super().__init__(
            "Sincronización detenida: la nube borraría %d de %d %s. Un administrador debe"
            " confirmar los borrados en la plataforma." % (would_delete, total, label))


def iso_ms(ms: int) -> str:
    """Milisegundos desde la época -> ISO-8601 UTC con milisegundos (`...T08:00:00.000Z`)."""
    moment = datetime.fromtimestamp(ms // 1000, timezone.utc)
    return "%s.%03dZ" % (moment.strftime("%Y-%m-%dT%H:%M:%S"), ms % 1000)


def _invalid(detail: str) -> CloudError:
    return CloudError(200, "invalid_response", detail)


def _check_mass_delete(conn: sqlite3.Connection, deletes: Mapping[str, Iterable[str]],
                       confirm: bool, count_pending: bool = False) -> None:
    """Lanza SyncBlocked si la nube borraría al menos MASS_DELETE_MIN registros y más de
    MASS_DELETE_RATIO de los vivos de titulares o tarjetas, sin `confirm_deletions`.
    Solo cuentan los registros que existen; los que tienen cambios locales pendientes cuentan
    solo con `count_pending` (el pull los borra igual; la reconciliación los conserva)."""
    if confirm:
        return
    pending = "" if count_pending else " AND uuid NOT IN (SELECT row_uuid FROM sync_outbox)"
    for table, _ in GUARDED_TABLES:
        would = sum(
            1 for row_id in deletes.get(table, ())
            if conn.execute("SELECT 1 FROM %s WHERE uuid = ?%s" % (table, pending), (row_id,)).fetchone())
        total = conn.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
        if would >= MASS_DELETE_MIN and would > MASS_DELETE_RATIO * total:
            raise SyncBlocked(table, would, total)


def _replacement(local: Mapping[str, List[Mapping[str, Any]]], remote: Mapping[str, Mapping[str, Any]]
                 ) -> Tuple[List[Dict[str, Any]], Dict[str, List[str]]]:
    """Cambios que dejan cada tabla de `remote` como el snapshot de la nube: borra lo que sobra y
    da de alta o cambia lo que difiere. Devuelve también los borrados por tabla."""
    changes = []  # type: List[Dict[str, Any]]
    deletes = {}  # type: Dict[str, List[str]]
    for table, rows in remote.items():
        mine = {r["id"]: r["data"] for r in local[table]}
        deletes[table] = [row_id for row_id in mine if row_id not in rows]
        changes.extend({"table": table, "op": "delete", "id": row_id} for row_id in deletes[table])
        changes.extend({"table": table, "op": "upsert", "id": row_id, "data": data}
                       for row_id, data in rows.items() if mine.get(row_id) != data)
    return changes, deletes


def _requeue(conn: sqlite3.Connection, table: str, op: str, row_uuid: str, updated_at: int) -> None:
    """Vuelve a encolar un cambio con un `change_id` nuevo (dentro de la transacción del agente)."""
    conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                 " VALUES (?, ?, ?, ?, ?)", (uuid.uuid4().hex, table, op, row_uuid, updated_at))


def _drop_duplicate_pin(conn: sqlite3.Connection, holder_uuid: str) -> Optional[str]:
    """Quita el PIN al titular local y lo reencola. Devuelve el aviso para `last_error` (sin el PIN),
    o None si el titular ya no existe."""
    row = conn.execute("SELECT name FROM holders WHERE uuid = ?", (holder_uuid,)).fetchone()
    if row is None:
        return None
    stamp = now_ms()
    conn.execute("UPDATE holders SET pin = NULL, updated_at = ? WHERE uuid = ?", (stamp, holder_uuid))
    _requeue(conn, "holders", "upsert", holder_uuid, stamp)
    return DUPLICATE_PIN_MESSAGE % str(row["name"])[:_NAME_MAX]


class SyncEngine:
    def __init__(self, db_path: Union[str, Path], api: CloudApi, *,
                 now: Callable[[], float] = time.time):
        self._db_path = Path(db_path)
        self._api = api
        self._now = now
        with self._connect() as conn:
            # Una guarda en 1 que quedara confirmada silenciaría la bandeja para siempre.
            conn.execute("UPDATE sync_guard SET applying=0 WHERE id=1")

    def _connect(self) -> "closing[sqlite3.Connection]":
        return closing(connect(self._db_path))

    def _now_iso(self) -> str:
        return iso_ms(int(self._now() * 1000))

    # --- push ---------------------------------------------------------------------------------

    def push(self) -> int:
        """Sube la bandeja en lotes de CHANGES_PAGE. Cada registro va una sola vez, con la última
        entrada de la bandeja y en su posición. Devuelve cuántos cambios se enviaron."""
        with self._connect() as conn:
            last = {}  # type: Dict[str, sqlite3.Row]
            for entry in conn.execute("SELECT seq, change_id, table_name, op, row_uuid, updated_at"
                                      " FROM sync_outbox ORDER BY seq").fetchall():
                last.pop(entry["row_uuid"], None)
                last[entry["row_uuid"]] = entry
            entries = list(last.values())
            sent = 0
            for start in range(0, len(entries), CHANGES_PAGE):
                sent += self._push_page(conn, entries[start:start + CHANGES_PAGE])
            return sent

    def _push_page(self, conn: sqlite3.Connection, page: List[sqlite3.Row]) -> int:
        items = {}  # type: Dict[str, Dict[str, Any]]
        entries = {}  # type: Dict[str, sqlite3.Row]
        for entry in page:
            item = {"change_id": entry["change_id"], "table": entry["table_name"], "op": entry["op"],
                    "id": entry["row_uuid"], "updated_at": iso_ms(entry["updated_at"])}
            if entry["op"] == "upsert":
                data = row_to_data(conn, entry["table_name"], entry["row_uuid"])
                if data is None:
                    continue  # la fila ya no existe (la borró un cambio de la nube)
                item["data"] = data
            items[entry["change_id"]] = item
            entries[entry["change_id"]] = entry
        results = []  # type: List[Any]
        if items:
            results = self._api.post_changes(list(items.values())).get("results")
            if not isinstance(results, list):
                raise _invalid("Falta la lista de resultados")
            answered = {r.get("change_id") for r in results if isinstance(r, dict)}
            if not set(items) <= answered:
                # Sin resultado no se sabe qué pasó: la bandeja queda intacta y se reintenta.
                raise _invalid("Faltan resultados de algunos cambios")
        with applying(conn):
            for entry in page:
                # Solo hasta esta entrada: una edición local posterior sigue pendiente.
                conn.execute("DELETE FROM sync_outbox WHERE row_uuid = ? AND seq <= ?",
                             (entry["row_uuid"], entry["seq"]))
            currents = []
            pin_notice = None
            for result in results:
                change_id = result.get("change_id") if isinstance(result, dict) else None
                if change_id not in items or result.get("status") == "applied":
                    continue
                item, entry = items[change_id], entries[change_id]
                if result.get("status") == "rejected":
                    reason = str(result.get("reason") or "sin motivo")[:_REASON_MAX]
                    set_state(conn, "last_error",
                              "La nube rechazó un cambio de %s: %s" % (item["table"], reason))
                    if reason == RELATED_MISSING:
                        _requeue(conn, entry["table_name"], entry["op"], entry["row_uuid"], entry["updated_at"])
                        continue
                    if (reason == DUPLICATE and item["table"] == "holders" and item["op"] == "upsert"
                            and item["data"]["pin"] is not None and result.get("current", False) is None):
                        # Alta de un titular cuyo PIN ya usa otro en la nube: borrarlo (current null)
                        # arrastraría sus tarjetas y controles. Se le quita el PIN y se vuelve a subir;
                        # sus hijos, rechazados por «relacionado no existe», ya se reencolaron.
                        pin_notice = _drop_duplicate_pin(conn, item["id"]) or pin_notice
                        continue
                if "current" in result:
                    current = result["current"]
                    if current is None:
                        currents.append({"table": item["table"], "op": "delete", "id": item["id"]})
                    elif isinstance(current, dict) and "data" in current:
                        currents.append({"table": item["table"], "op": "upsert", "id": item["id"],
                                         "data": current["data"]})
            if pin_notice:
                # Después del bucle: los rechazos de sus hijos no deben tapar el aviso del PIN.
                set_state(conn, "last_error", pin_notice)
            # Un `current` cuyo padre aún no está en el panel se omite: no debe atascar la página.
            apply_changes(conn, currents, skip_missing_parents=True)
        return len(items)

    # --- pull ---------------------------------------------------------------------------------

    def pull(self) -> int:
        """Descarga todas las páginas desde `cloud_revision`, revisa los borrados masivos y aplica
        todo en una transacción junto con el cursor nuevo. Si la descarga falla, no aplica nada.
        Las altas y cambios no pisan filas con cambios pendientes; los borrados sí (y quitan sus
        entradas de la bandeja)."""
        with self._connect() as conn:
            cursor = int(get_state(conn, "cloud_revision", "0") or 0)
            changes = []  # type: List[Mapping[str, Any]]
            confirm = False
            while True:
                page = self._api.get_changes(since=cursor, limit=CHANGES_PAGE)
                revision, has_more, page_changes = self._read_page(page)
                if revision < cursor:
                    # La nube va detrás del panel (p. ej. una base restaurada): no basta con bajar
                    # el cursor, se compara todo.
                    log.warning("La revisión de la nube (%d) es menor que la del panel (%d):"
                                " se reconcilia", revision, cursor)
                    self.reconcile()
                    return 0
                if has_more and revision == cursor:
                    raise _invalid("La nube no avanzó la revisión")
                changes.extend(page_changes)
                confirm = bool(page.get("confirm_deletions"))
                cursor = revision
                if not has_more:
                    break
            final = list(collapse(changes).values())
            deletes = {table: [c["id"] for c in final if c["table"] == table and c["op"] == "delete"]
                       for table, _ in GUARDED_TABLES}
            # Un borrado de la nube se aplica aunque la fila tenga cambios pendientes: una revocación
            # debe llegar aunque el push de esa fila esté fallando.
            applied = self._guarded(lambda: apply_batch(
                conn, final, state={"cloud_revision": str(cursor), "last_sync_at": self._now_iso()},
                check=lambda c: _check_mass_delete(c, deletes, confirm, count_pending=True),
                force_deletes=True))
            log.info("Pull: %d cambios aplicados hasta la revisión %d", applied, cursor)
            return applied

    @staticmethod
    def _read_page(page: Mapping[str, Any]) -> Tuple[int, bool, List[Mapping[str, Any]]]:
        try:
            revision, has_more, changes = int(page["revision"]), bool(page["has_more"]), page["changes"]
        except (KeyError, TypeError, ValueError):
            raise _invalid("Respuesta de cambios incompleta") from None
        if not isinstance(changes, list) or not all(
                isinstance(c, dict) and "table" in c and "op" in c and "id" in c for c in changes):
            raise _invalid("Lista de cambios inválida")
        return revision, has_more, changes

    def _guarded(self, run: Callable[[], Any]) -> Any:
        """Corre `run`; si la protección contra borrados masivos lo detuvo (ya fuera de la
        transacción), avisa a la nube y vuelve a lanzar SyncBlocked."""
        try:
            return run()
        except SyncBlocked as blocked:
            alert = {"type": "mass_delete_blocked", "table": blocked.table,
                     "would_delete": blocked.would_delete, "total": blocked.total}
            try:
                self._api.post_alert(alert)
            except CloudError as exc:
                log.warning("No se pudo avisar a la nube del borrado masivo: %s", exc)
            log.warning("%s", blocked)
            raise

    # --- reconcile y adopción -----------------------------------------------------------------

    def _snapshots(self, tables: Iterable[str]) -> Dict[str, Dict[str, Any]]:
        """`{tabla: {id: data}}` de la nube para esas tablas."""
        remote = {}  # type: Dict[str, Dict[str, Any]]
        for table in tables:
            rows = self._api.get_snapshot(table).get("rows")
            if not isinstance(rows, list):
                raise _invalid("Snapshot inválido")
            remote[table] = {r["id"]: r["data"] for r in rows}
        return remote

    def reconcile(self) -> List[str]:
        """Compara los checksums por tabla y reemplaza las tablas distintas con su snapshot de la
        nube (con la protección contra borrados masivos). Devuelve las tablas reemplazadas.

        Una fila con cambios pendientes no se toca, tampoco para borrarla: que falte en el snapshot
        no distingue un borrado de la nube de un alta local que aún no se sube. Los borrados de la
        nube llegan por el pull (que corre antes en cada ciclo)."""
        sums = self._api.get_checksums()
        try:
            revision, remote_sums = int(sums["revision"]), dict(sums["tables"])
        except (KeyError, TypeError, ValueError):
            raise _invalid("Respuesta de checksums incompleta") from None
        confirm = bool(sums.get("confirm_deletions"))
        with self._connect() as conn:
            local = snapshot_tables(conn)
            differing = [t for t in REPLICATED_TABLES if table_checksum(local[t]) != remote_sums.get(t)]
            remote = self._snapshots(differing)

            def replace() -> None:
                with applying(conn):
                    # La diferencia se calcula dentro de la transacción: nada local cambia en medio.
                    changes, deletes = _replacement(snapshot_tables(conn), remote)
                    _check_mass_delete(conn, deletes, confirm)
                    apply_changes(conn, changes)
                    # Las tablas iguales ya están al día hasta `revision`; las reemplazadas, más.
                    set_state(conn, "cloud_revision", str(revision))

            self._guarded(replace)
        if differing:
            log.info("Reconciliación: se reemplazaron %s", ", ".join(differing))
        return differing

    def adopt_cloud(self) -> None:
        """Adopta los datos de la nube tras la importación: descarga los snapshots, respalda la base
        (solo en el primer intento de esta adopción), reemplaza las tablas
        replicadas (salvo los valores de `outputs`, que solo toman el UUID de la nube), vacía la
        bandeja (y encola las salidas cuyos valores locales difieren de la nube) y deja el cursor
        en la revisión previa a los snapshots (R0)."""
        sums = self._api.get_checksums()
        try:
            r0 = int(sums["revision"])
        except (KeyError, TypeError, ValueError):
            raise _invalid("Respuesta de checksums incompleta") from None
        with self._connect() as conn:
            remote = self._snapshots(REPLICATED_TABLES)
            # Después de descargar y una sola vez por adopción: un reintento cada RETRY_S no debe
            # escribir una copia completa de la base en la SD.
            if get_state(conn, ADOPT_BACKUP_KEY) != "1":
                self._backup(conn)
                with transaction(conn):
                    set_state(conn, ADOPT_BACKUP_KEY, "1")
            outputs = remote.pop("outputs")
            with applying(conn):
                changes, _ = _replacement(snapshot_tables(conn), remote)
                apply_changes(conn, changes, keep_pending=False)
                for output_uuid, data in outputs.items():
                    output_id = data["output_id"]
                    conn.execute("UPDATE outputs SET uuid = ? WHERE uuid = ? AND output_id <> ?",
                                 (str(uuid.uuid4()), output_uuid, output_id))
                    conn.execute("UPDATE outputs SET uuid = ? WHERE output_id = ?", (output_uuid, output_id))
                conn.execute("DELETE FROM sync_outbox")
                # Las salidas conservan sus valores locales: los que difieren de la nube se suben.
                for output_uuid, data in outputs.items():
                    if row_to_data(conn, "outputs", output_uuid) not in (None, data):
                        conn.execute(
                            "INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                            " SELECT ?, 'outputs', 'upsert', uuid, updated_at FROM outputs WHERE uuid = ?",
                            (uuid.uuid4().hex, output_uuid))
                set_state(conn, "cloud_revision", str(r0))
                conn.execute("DELETE FROM sync_state WHERE key = ?", (ADOPT_BACKUP_KEY,))
        log.info("Datos de la nube adoptados (revisión %d)", r0)

    def _backup(self, conn: sqlite3.Connection) -> Path:
        """Respaldo con la API de backup de SQLite, en modo 0600 desde su creación (la base guarda
        PIN en claro). Un respaldo previo se conserva con fecha; en total quedan como máximo
        MAX_DATED_BACKUPS copias (el vigente y los fechados más recientes)."""
        stem = self._db_path.stem
        path = self._db_path.with_name("%s_backup_adopt.sqlite" % stem)
        tmp = path.with_name(path.name + ".tmp")
        if tmp.exists():
            tmp.unlink()
        os.close(os.open(str(tmp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        target = sqlite3.connect(str(tmp))
        try:
            conn.backup(target)
        finally:
            target.close()
        os.chmod(str(tmp), 0o600)
        if path.exists():
            stamp = datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y%m%d-%H%M%S")
            os.replace(str(path), str(path.with_name("%s_backup_adopt.%s.sqlite" % (stem, stamp))))
        os.replace(str(tmp), str(path))
        dated = sorted(self._db_path.parent.glob("%s_backup_adopt.*.sqlite" % stem),
                       key=lambda p: (p.stat().st_mtime, p.name))
        for old in dated[:-(MAX_DATED_BACKUPS - 1)]:
            old.unlink()
        return path

    # --- logs ---------------------------------------------------------------------------------

    def upload_logs(self) -> int:
        """Sube los logs nuevos desde `last_log_uploaded` en lotes de LOG_BATCH. Devuelve cuántos."""
        total = 0
        with self._connect() as conn:
            while True:
                last = int(get_state(conn, "last_log_uploaded", "0") or 0)
                rows = conn.execute(
                    "SELECT l.*, h.uuid AS holder_uuid, k.uuid AS control_uuid FROM access_logs l"
                    " LEFT JOIN holders h ON h.holder_id = l.holder_id"
                    " LEFT JOIN controls k ON k.control_id = l.control_id"
                    " WHERE l.log_id > ? ORDER BY l.log_id LIMIT ?", (last, LOG_BATCH)).fetchall()
                if not rows:
                    break
                logs = [self._log_item(row) for row in rows]
                self._api.post_logs(logs)
                with transaction(conn):
                    set_state(conn, "last_log_uploaded", str(rows[-1]["log_id"]))
                total += len(rows)
                if len(rows) < LOG_BATCH:
                    break
        return total

    @staticmethod
    def _log_item(row: sqlite3.Row) -> Dict[str, Any]:
        def text(value: Any) -> Any:
            return None if value is None else str(value)[:_TEXT_MAX]

        return {
            "local_log_id": row["log_id"],
            "timestamp": iso_ms(int(row["timestamp"]) * 1000),
            "allowed": bool(row["allowed"]),
            "source": row["source"],
            "reason": row["reason"],
            "holder_id": row["holder_uuid"],
            "holder_name": text(row["holder_name"]),
            "holder_kind": row["holder_kind"],
            "credential_label": text(row["credential_label"]),
            "control_id": row["control_uuid"],
            # Un log de PIN nunca lleva dígitos, aunque la fila local tuviera algo.
            "code": None if row["source"] == SOURCE_PIN else row["code"],
            "device_id": row["device_id"],
            "output_id": row["output_id"],
        }
