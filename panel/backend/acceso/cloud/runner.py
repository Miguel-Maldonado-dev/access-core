"""Planificador del agente acceso-cloud: una máquina de estados de un solo hilo.

Estados (guardados en `sync_state.state`):
  unlinked         register cada 30 s y activate cada 10 s hasta que la plataforma reclama el panel.
  staging          sube el snapshot local (import_snapshot).
  awaiting_review  consulta link_state cada 30 s hasta que un administrador revisa la importación.
  active           adopt_cloud una sola vez y luego el ciclo push -> pull -> upload_logs.

Ciclo activo, con un solo ciclo pendiente aunque lleguen muchos disparadores: aviso MQTT (solo si
trae una revisión mayor que `cloud_revision`), cada SYNC_INTERVAL_S, entradas nuevas en la bandeja
(revisada cada OUTBOX_POLL_S) y reconcile cada RECONCILE_INTERVAL_S. Un 401 `unauthorized` de la nube
en cualquier llamada autenticada es una revocación: se borran las credenciales, se regenera el código de
vinculación y se vuelve a `unlinked` sin tocar los datos locales. Un 401 sin ese código no viene de la
nube (proxy, portal cautivo): se trata como un error de red.

Órdenes de la nube por MQTT: `upload_logs` sube los logs en el siguiente tick (sin push ni pull; varias
órdenes seguidas dan una sola subida) y `test_output` pasa al worker de órdenes, que corre en su propio
hilo con su propia CloudApi (CloudApi no es segura entre hilos). El worker se crea al tener credencial y
se detiene al revocar o al cerrar.

Los errores se registran sin tumbar el proceso y nunca con secretos: de una excepción inesperada solo
se registra su tipo, y los mensajes de CloudError, SyncBlocked e InvalidChange ya están en español y
sin datos sensibles.
"""
import logging
import os
import sqlite3
import threading
import time
from contextlib import closing
from functools import partial
from importlib import metadata
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple, Union

from acceso.cloud.api import CloudApi, CloudError
from acceso.cloud.config import CloudSettings, clear_credentials, load_credentials, save_credentials
from acceso.cloud.identity import Identity, ensure_identity, get_state, regenerate_claim_code, set_state
from acceso.cloud.mapping import InvalidChange, snapshot_tables
from acceso.cloud.sync import ADOPT_BACKUP_KEY, SyncBlocked
from acceso.config import ConfigError
from acceso.constants import SCHEMA_VERSION
from acceso.db import connect

log = logging.getLogger("acceso.cloud")

def interval_from_env(name: str, default: int) -> int:
    """Entero positivo de la variable de entorno `name`; si falta o no es válido, `default`."""
    try:
        value = int((os.environ.get(name) or "").strip())
    except ValueError:
        return default
    return value if value > 0 else default


# SYNC_INTERVAL_S solo se cambia por entorno en la prueba de punta a punta (cloud/e2e).
SYNC_INTERVAL_S = interval_from_env("SYNC_INTERVAL_S", 300)
RECONCILE_INTERVAL_S = 86400
OUTBOX_POLL_S = 5
TICK_S = 1.0
REGISTER_EVERY_S = 30
ACTIVATE_EVERY_S = 10
REVIEW_POLL_S = 30
RETRY_S = 30  # reintento de import_snapshot y de adopt_cloud tras un fallo
LAST_ERROR_MAX = 500

UNLINKED, STAGING, AWAITING_REVIEW, ACTIVE = "unlinked", "staging", "awaiting_review", "active"
_NEVER = float("-inf")  # "vencido desde siempre": la acción corre en el siguiente tick

ALREADY_ACTIVATED_MESSAGE = (
    "El panel ya se activó pero perdió su credencial. Desvincúlalo en la plataforma y vuelve a vincularlo.")
REVOKED_MESSAGE = "La plataforma revocó este panel: se registra de nuevo con un código de vinculación nuevo."


def _software_version() -> str:
    try:
        return metadata.version("acceso-panel")
    except metadata.PackageNotFoundError:
        return "desconocida"


def _describe(label: str, exc: BaseException) -> str:
    """Texto para `last_error` y el registro. Nunca incluye el texto de una excepción inesperada."""
    if isinstance(exc, CloudError):
        return "%s: %s" % (label, exc)
    if isinstance(exc, (SyncBlocked, InvalidChange, ConfigError)):
        return str(exc)
    return "%s: error inesperado (%s)" % (label, type(exc).__name__)


def _is_revocation(exc: BaseException) -> bool:
    """Solo un 401 con el código `unauthorized` de la nube revoca. Otro 401 (un proxy, la protección de
    despliegues de Vercel o un portal cautivo, sin el JSON de la nube) es un error de red: se anota y se
    reintenta sin borrar la credencial."""
    return isinstance(exc, CloudError) and exc.status == 401 and exc.code == "unauthorized"


class Runner:
    def __init__(self, settings: CloudSettings, db_path: Union[str, Path], api: CloudApi,
                 engine_factory: Callable[[Path, CloudApi], Any],
                 mqtt_factory: Callable[..., Any],
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep,
                 wall: Callable[[], float] = time.time,
                 command_worker_factory: Optional[Callable[[CloudApi], Any]] = None):
        self._settings = settings
        self._db_path = Path(db_path)
        self._api = api
        self._engine_factory = engine_factory
        self._mqtt_factory = mqtt_factory
        self._command_worker_factory = command_worker_factory
        self._clock = clock
        self._sleep = sleep
        self._wall = wall
        self._engine = None  # type: Optional[Any]
        self._link = None  # type: Optional[Any]
        self._worker = None  # type: Optional[Any]
        self._worker_api = None  # type: Optional[CloudApi]
        self._credentials = None  # type: Optional[Tuple[str, str]]
        self._state = UNLINKED
        self._adopted = False
        self._due = {}  # type: Dict[str, float]
        self._next_sync = _NEVER
        self._next_outbox_check = _NEVER
        self._next_mqtt = _NEVER
        self._next_worker = _NEVER
        self._outbox_seen = 0
        self._notice = 0
        self._logs_requested = False
        self._notice_lock = threading.Lock()

    # --- ciclo de vida -----------------------------------------------------------------------

    def start(self) -> None:
        """Crea el motor (que repone `sync_guard.applying=0`), asegura la identidad y reanuda el
        estado guardado."""
        now = self._clock()
        self._engine = self._engine_factory(self._db_path, self._api)
        with self._db() as conn:
            ensure_identity(conn)
            self._state = get_state(conn, "state") or UNLINKED
            self._adopted = get_state(conn, "adopted") == "1"
        self._credentials = load_credentials(self._settings.credentials_path)
        if self._credentials is None:
            if self._state != UNLINKED:
                log.warning("Hay un estado de vinculación (%s) pero no credenciales: se regresa a «sin vincular»",
                            self._state)
                self._set_state(UNLINKED)
        else:
            self._api.authenticate(*self._credentials)
            if self._state == UNLINKED:  # la activación llegó a guardarse pero el estado no
                self._set_state(STAGING)

    def run(self, stop: Any) -> None:
        """Bucle principal hasta que `stop.is_set()`; `sleep` es `stop.wait` en el servicio."""
        self.start()
        try:
            while not stop.is_set():
                self.tick()
                self._sleep(TICK_S)
        finally:
            self.close()

    def close(self) -> None:
        self._stop_link()
        self._stop_worker()

    def tick(self) -> None:
        """Hace lo que esté vencido. Nunca lanza: un error se registra y se anota en `last_error`."""
        try:
            self._tick()
        except Exception as exc:
            text = "Error inesperado del agente (%s)" % type(exc).__name__
            log.error("%s", text)
            try:
                self._note_error(text)
            except Exception:  # la base puede estar ocupada: se reintenta en el siguiente tick
                pass

    def _tick(self) -> None:
        now = self._clock()
        if not self._settings.cloud_url:
            if self._is_due("config", now):
                self._schedule("config", now, REGISTER_EVERY_S)
                self._note_error("Falta configurar CLOUD_URL en %s." % self._settings.credentials_path)
            return
        self._ensure_link(now)
        self._ensure_worker(now)
        if self._state == UNLINKED:
            self._unlinked(now)
        elif self._state == STAGING:
            self._staging(now)
        elif self._state == AWAITING_REVIEW:
            self._awaiting_review(now)
        elif self._state == ACTIVE:
            self._active(now)

    # --- base de datos y estado --------------------------------------------------------------

    def _db(self) -> "closing[sqlite3.Connection]":
        return closing(connect(self._db_path))

    def _get(self, key: str) -> Optional[str]:
        with self._db() as conn:
            return get_state(conn, key)

    def _put(self, key: str, value: str) -> None:
        with self._db() as conn:
            set_state(conn, key, value)

    def _drop(self, *keys: str) -> None:
        with self._db() as conn:
            for key in keys:
                conn.execute("DELETE FROM sync_state WHERE key = ?", (key,))

    def _note_error(self, text: str) -> None:
        self._put("last_error", text[:LAST_ERROR_MAX])

    def _identity(self) -> Identity:
        with self._db() as conn:
            return ensure_identity(conn)

    def _set_state(self, new: str) -> None:
        self._put("state", new)
        if new != ACTIVE:
            # Al volver a active hay que adoptar de nuevo, con un respaldo nuevo de la base.
            self._drop("adopted", ADOPT_BACKUP_KEY)
            self._adopted = False
        if new != self._state:
            log.info("Estado de vinculación: %s", new)
        self._state = new
        self._due.clear()

    def _is_due(self, name: str, now: float) -> bool:
        return now >= self._due.get(name, _NEVER)

    def _schedule(self, name: str, now: float, seconds: float) -> None:
        self._due[name] = now + seconds

    # --- errores ---------------------------------------------------------------------------

    def _failed(self, label: str, exc: BaseException) -> bool:
        """Anota el fallo de una llamada. Un 401 autenticado de la nube es una revocación: devuelve True
        si ya se revocó (el llamador debe abandonar lo que hacía)."""
        if _is_revocation(exc) and self._state != UNLINKED:
            self._revoke()
            return True
        text = _describe(label, exc)
        log.warning("%s", text)
        self._note_error(text)
        return False

    def _revoke(self) -> None:
        log.warning("La plataforma desvinculó este panel: se regresa a «sin vincular» con un código nuevo")
        self._stop_link()
        self._stop_worker()
        try:
            clear_credentials(self._settings.credentials_path)
        except ConfigError as exc:
            log.error("%s", exc)
        self._credentials = None
        with self._db() as conn:
            regenerate_claim_code(conn)
        self._set_state(UNLINKED)

    # --- unlinked ----------------------------------------------------------------------------

    def _unlinked(self, now: float) -> None:
        identity = None  # type: Optional[Identity]
        if self._is_due("register", now):
            self._schedule("register", now, REGISTER_EVERY_S)
            identity = self._identity()
            versions = {"software_version": _software_version(), "schema_version": SCHEMA_VERSION}
            try:
                self._api.register(identity, versions)
            except CloudError as exc:
                self._failed("Registro del panel", exc)
        if self._is_due("activate", now):
            self._schedule("activate", now, ACTIVATE_EVERY_S)
            identity = identity or self._identity()
            try:
                activation = self._api.activate(identity.panel_code, identity.panel_secret)
            except CloudError as exc:
                self._activation_failed(exc)
                return
            self._drop("last_error")
            if activation is not None:
                self._activated(identity.panel_code, activation.device_token,
                                activation.installation_id, activation.installation_name)

    def _activation_failed(self, exc: CloudError) -> None:
        if exc.status == 410:  # revocado: la nube ya no conoce el código viejo
            with self._db() as conn:
                regenerate_claim_code(conn)
            self._due["register"] = _NEVER
            self._note_error(REVOKED_MESSAGE)
        elif exc.status == 401:  # la nube no conoce este panel: registrarlo ya
            self._due["register"] = _NEVER
            self._failed("Activación del panel", exc)
        elif exc.status == 409 and exc.code == "already_activated":
            self._note_error(ALREADY_ACTIVATED_MESSAGE)
        else:
            self._failed("Activación del panel", exc)

    def _activated(self, panel_code: str, token: str, installation_id: str, installation_name: str) -> None:
        try:
            save_credentials(self._settings.credentials_path, panel_code, token)
        except ConfigError as exc:
            log.error("%s", exc)
            self._note_error(str(exc))
            return
        self._credentials = (panel_code, token)
        self._api.authenticate(panel_code, token)
        self._put("installation_id", installation_id)
        self._put("installation_name", installation_name)
        self._set_state(STAGING)
        log.info("Panel vinculado a la plataforma")

    # --- staging y awaiting_review ------------------------------------------------------------

    def _staging(self, now: float) -> None:
        if not self._is_due("import", now):
            return
        self._schedule("import", now, RETRY_S)
        with self._db() as conn:
            tables = snapshot_tables(conn)
        try:
            status = self._api.import_snapshot(tables)
        except CloudError as exc:
            if exc.status == 409:  # p. ej. se perdió la respuesta de un intento anterior
                self._resync_state()
            else:
                self._failed("Importación de los datos del panel", exc)
            return
        self._apply_link_status(status, now)

    def _awaiting_review(self, now: float) -> None:
        if not self._is_due("review", now):
            return
        self._schedule("review", now, REVIEW_POLL_S)
        self._resync_state()

    def _resync_state(self) -> None:
        """Consulta link_state y ajusta el estado local."""
        try:
            status = self._api.link_state()
        except CloudError as exc:
            self._failed("Consulta del estado de vinculación", exc)
            return
        self._apply_link_status(status, self._clock())

    def _apply_link_status(self, status: str, now: float) -> None:
        if status not in (STAGING, AWAITING_REVIEW, ACTIVE):
            self._note_error("La plataforma respondió un estado de vinculación desconocido.")
            return
        self._drop("last_error")
        if status != self._state:
            self._set_state(status)
            if status == AWAITING_REVIEW:
                self._schedule("review", now, REVIEW_POLL_S)
            elif status == ACTIVE:
                self._next_sync = _NEVER

    # --- active ------------------------------------------------------------------------------

    def _active(self, now: float) -> None:
        if not self._adopted:
            if not self._is_due("adopt", now):
                return
            self._schedule("adopt", now, RETRY_S)
            try:
                self._engine.adopt_cloud()
            except Exception as exc:
                self._failed("Adopción de los datos de la nube", exc)
                return
            self._put("adopted", "1")
            self._adopted = True
            self._put("last_reconcile_at", str(int(self._wall())))  # adoptar cuenta como reconciliar
            self._next_sync = _NEVER
        logs_requested = self._take_logs_request()
        if self._cycle_due(now):
            # El ciclo ya sube los logs: la orden solo hace que avise aunque no haya pendientes.
            self._run_cycle(always_post=logs_requested)
        elif logs_requested:
            self._upload_logs_now()

    def _cycle_due(self, now: float) -> bool:
        due = now >= self._next_sync
        if self._take_notice():
            due = True
        if now >= self._next_outbox_check:
            self._next_outbox_check = now + OUTBOX_POLL_S
            if self._outbox_last() > self._outbox_seen:
                due = True
        return due

    def _take_notice(self) -> bool:
        """Consume los avisos MQTT; True si alguno trae una revisión mayor que `cloud_revision`."""
        with self._notice_lock:
            revision, self._notice = self._notice, 0
        if revision == 0:
            return False
        return revision > int(self._get("cloud_revision") or 0)

    def _outbox_last(self) -> int:
        with self._db() as conn:
            return conn.execute("SELECT COALESCE(MAX(seq), 0) FROM sync_outbox").fetchone()[0]

    def _run_cycle(self, always_post: bool = False) -> None:
        """push -> pull -> (reconcile si toca) -> upload_logs. Cada paso con su manejo de errores.

        `always_post` (orden «Actualizar logs») hace que la subida de logs avise a la nube aunque no
        haya logs pendientes."""
        # Lo que ya estaba en la bandeja no cuenta como "nuevo": una entrada atascada no repite el ciclo.
        # La marca se renueva justo después del push (ver abajo) para que tampoco cuenten las entradas
        # que el propio push vuelve a encolar («relacionado no existe»): se reintentan en el siguiente
        # disparador normal (aviso MQTT, SYNC_INTERVAL_S o una edición local nueva).
        self._outbox_seen = self._outbox_last()
        self._drop("last_error")
        engine = self._engine
        steps = [("Subida de cambios", engine.push, "push"), ("Descarga de cambios", engine.pull, None)]
        if self._reconcile_due():
            steps.append(("Reconciliación", engine.reconcile, "reconcile"))
        upload = partial(engine.upload_logs, always_post=True) if always_post else engine.upload_logs
        steps.append(("Subida de logs", upload, None))
        errors = []  # type: List[str]
        for label, step, kind in steps:
            try:
                step()
            except Exception as exc:
                text = self._cloud_step_failed(label, exc)
                if text is None:
                    return
                errors.append(text)
            else:
                if kind == "reconcile":
                    self._put("last_reconcile_at", str(int(self._wall())))
            if kind == "push":
                self._outbox_seen = self._outbox_last()
        self._next_sync = self._clock() + SYNC_INTERVAL_S
        if errors:
            for text in errors:
                log.warning("%s", text)
            self._merge_error(errors)

    def _upload_logs_now(self) -> None:
        """Orden «Actualizar logs» de la nube fuera del ciclo: solo la subida de logs, con el mismo
        manejo de errores y revocación que el ciclo. No borra `last_error` del último ciclo."""
        try:
            self._engine.upload_logs(always_post=True)
        except Exception as exc:
            text = self._cloud_step_failed("Subida de logs", exc)
            if text is not None:
                log.warning("%s", text)
                self._merge_error([text])

    def _cloud_step_failed(self, label: str, exc: BaseException) -> Optional[str]:
        """Manejo común de la falla de un paso del ciclo activo. Un 409 `not_active` (el panel dejó de
        estar activo en la nube) consulta link_state y un 401 de la nube revoca: en ambos casos
        devuelve None y el llamador abandona lo que hacía. Si no, devuelve el texto del error."""
        if isinstance(exc, CloudError):
            if exc.status == 409 and exc.code == "not_active":
                self._resync_state()
                return None
            if _is_revocation(exc):
                self._revoke()
                return None
        return _describe(label, exc)

    def _reconcile_due(self) -> bool:
        """Vence según la hora de pared guardada (sobrevive a reinicios). Sin registro, o con un
        registro en el futuro (el reloj retrocedió), toca reconciliar."""
        try:
            last = float(self._get("last_reconcile_at") or "")
        except ValueError:
            return True
        now = self._wall()
        return last > now or now - last >= RECONCILE_INTERVAL_S

    def _merge_error(self, errors: List[str]) -> None:
        """Anota los errores del ciclo y conserva el aviso que el motor haya dejado en `last_error`."""
        text = " | ".join(errors)
        existing = self._get("last_error")
        if existing and existing not in text:
            text = existing + " | " + text
        self._note_error(text)

    # --- MQTT --------------------------------------------------------------------------------

    def _notify(self, revision: int) -> None:
        """Aviso de la nube (hilo de MQTT): solo guarda la revisión más alta."""
        with self._notice_lock:
            self._notice = max(self._notice, revision)

    def _take_logs_request(self) -> bool:
        with self._notice_lock:
            requested, self._logs_requested = self._logs_requested, False
        return requested

    def _command(self, body: Dict[str, Any]) -> None:
        """Orden de la nube (hilo de MQTT). `upload_logs` solo levanta una bandera que atiende el
        siguiente tick; `test_output` va al worker, y solo con el panel activo."""
        kind = body.get("type")
        if kind == "upload_logs":
            with self._notice_lock:
                self._logs_requested = True
        elif kind == "test_output":
            worker = self._worker
            if self._state == ACTIVE and worker is not None:
                worker.submit(body)

    def _ensure_link(self, now: float) -> None:
        if (self._state == UNLINKED or self._credentials is None or self._link is not None
                or not self._settings.mqtt_url or now < self._next_mqtt):
            return
        code, token = self._credentials
        try:
            link = self._mqtt_factory(self._settings, code, token, self._notify, on_command=self._command)
            link.start()
        except ConfigError as exc:
            self._next_mqtt = now + SYNC_INTERVAL_S
            log.warning("No se pudo iniciar el enlace MQTT: %s", exc)
            return
        except Exception as exc:
            self._next_mqtt = now + SYNC_INTERVAL_S
            log.warning("No se pudo iniciar el enlace MQTT (%s); la sincronización periódica sigue",
                        type(exc).__name__)
            return
        self._link = link

    def _stop_link(self) -> None:
        link, self._link = self._link, None
        if link is None:
            return
        try:
            link.stop()
        except Exception as exc:
            log.warning("No se pudo cerrar el enlace MQTT (%s)", type(exc).__name__)

    # --- worker de órdenes ---------------------------------------------------------------------

    def _ensure_worker(self, now: float) -> None:
        """Crea el worker con una CloudApi propia, autenticada con la credencial vigente."""
        # Las órdenes solo llegan por MQTT: sin MQTT_URL no hace falta el worker.
        if (self._command_worker_factory is None or self._state == UNLINKED or self._credentials is None
                or not self._settings.mqtt_url or self._worker is not None or now < self._next_worker):
            return
        api = CloudApi(self._settings.cloud_url)
        try:
            api.authenticate(*self._credentials)
            worker = self._command_worker_factory(api)
            worker.start()
        except Exception as exc:
            api.close()
            self._next_worker = now + SYNC_INTERVAL_S
            log.warning("No se pudo iniciar el worker de órdenes de la nube (%s)", type(exc).__name__)
            return
        self._worker, self._worker_api = worker, api

    def _stop_worker(self) -> None:
        worker, self._worker = self._worker, None
        api, self._worker_api = self._worker_api, None
        if worker is not None:
            try:
                worker.stop()
            except Exception as exc:
                log.warning("No se pudo detener el worker de órdenes (%s)", type(exc).__name__)
        if api is not None:
            api.close()
