"""Planificador del agente acceso-cloud: máquina de estados, disparadores y revocación.

Todo es simulado: reloj y `sleep` falsos, nube (CloudApi), motor de sincronización y MQTT falsos,
y una base SQLite temporal real. Nunca se llama a la nube ni a un broker.
"""
import logging
import sqlite3
import time
from pathlib import Path

import pytest
from fake_cloud import FakeCloud

from acceso.cloud.api import Activation, CloudError
from acceso.cloud.config import CloudSettings, load_credentials, save_credentials
from acceso.cloud.identity import ensure_identity, get_state, set_state
from acceso.cloud.mapping import InvalidChange
from acceso.cloud.runner import (
    OUTBOX_POLL_S, RECONCILE_INTERVAL_S, RETRY_S, SYNC_INTERVAL_S, Runner,
)
from acceso.cloud.sync import ADOPT_BACKUP_KEY, SyncBlocked, SyncEngine
from acceso.constants import SCHEMA_VERSION
from acceso.store import holders
from acceso.store.holders import HolderData

CODE = "PNL-0123-4ABC"
TOKEN = "Tk3n" + "x" * 39
CLOUD_URL = "https://nube.example.com"
MQTT_URL = "mqtts://mqtt.example.com:8883"
ALREADY_ACTIVATED = ("El panel ya se activó pero perdió su credencial. Desvincúlalo en la plataforma"
                     " y vuelve a vincularlo.")


class Seq:
    """Resultados consecutivos de una llamada falsa; el último se repite. Las excepciones se lanzan."""

    def __init__(self, *items):
        self.items = list(items)

    def next(self):
        item = self.items.pop(0) if len(self.items) > 1 else self.items[0]
        if isinstance(item, BaseException):
            raise item
        return item


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeApi:
    def __init__(self, calls):
        self.calls = calls
        self.auth = None
        self.registered = []   # (claim_code, versions) de cada register
        self.register_result = Seq("pending")
        self.activate_result = Seq(None)
        self.import_result = Seq("active")
        self.link_result = Seq("active")
        self.snapshots = []

    def authenticate(self, panel_code, token):
        self.auth = (panel_code, token)

    def register(self, identity, versions):
        self.calls.append("register")
        self.registered.append((identity.claim_code, dict(versions)))
        return self.register_result.next()

    def activate(self, panel_code, panel_secret):
        self.calls.append("activate")
        result = self.activate_result.next()
        if result == "token":
            return Activation(TOKEN, "inst-1", "Fraccionamiento Demo")
        return result

    def import_snapshot(self, tables):
        self.calls.append("import_snapshot")
        self.snapshots.append(tables)
        return self.import_result.next()

    def link_state(self):
        self.calls.append("link_state")
        return self.link_result.next()


class FakeEngine:
    NAMES = ("push", "pull", "reconcile", "upload_logs", "adopt_cloud")

    def __init__(self, calls):
        self.calls = calls
        self.script = {name: Seq(None) for name in self.NAMES}
        self.hooks = {}
        self.always_post = []   # el argumento de cada upload_logs

    def _run(self, name):
        self.calls.append(name)
        if name in self.hooks:
            self.hooks[name]()
        return self.script[name].next()

    push = lambda self: self._run("push")  # noqa: E731
    pull = lambda self: self._run("pull")  # noqa: E731
    reconcile = lambda self: self._run("reconcile")  # noqa: E731
    def upload_logs(self, always_post=False):
        self.always_post.append(always_post)
        return self._run("upload_logs")

    adopt_cloud = lambda self: self._run("adopt_cloud")  # noqa: E731


class FakeMqtt:
    def __init__(self, calls, settings, panel_code, token, on_sync, on_command=None):
        self.calls = calls
        self.args = (settings, panel_code, token)
        self.on_sync = on_sync
        self.on_command = on_command

    def start(self):
        self.calls.append("mqtt.start")

    def stop(self):
        self.calls.append("mqtt.stop")


class FakeWorker:
    """Registra aparte (no en `calls`) para no alterar el orden que verifican las demás pruebas."""

    def __init__(self, api):
        self.api = api
        self.events = []
        self.submitted = []

    def start(self):
        self.events.append("start")

    def stop(self):
        self.events.append("stop")

    def submit(self, body):
        self.submitted.append(body)


class Stop:
    def __init__(self):
        self.stopped = False

    def is_set(self):
        return self.stopped

    def set(self):
        self.stopped = True


class Harness:
    def __init__(self, tmp_path, conn, cloud_url=CLOUD_URL, mqtt_url=MQTT_URL):
        self.conn = conn
        self.db_path = tmp_path / "test.sqlite"
        self.env_path = tmp_path / "cloud.env"
        self.env_path.write_text("CLOUD_URL=%s\nMQTT_URL=%s\n" % (cloud_url, mqtt_url))
        self.settings = CloudSettings(cloud_url, mqtt_url, self.env_path)
        self.calls = []
        self.clock = Clock()
        self.api = FakeApi(self.calls)
        self.engine = FakeEngine(self.calls)
        self.links = []
        self.workers = []
        self.mqtt_error = None
        self.engine_factory_args = []

    def engine_factory(self, db_path, api):
        self.engine_factory_args.append((db_path, api))
        return self.engine

    def mqtt_factory(self, settings, panel_code, token, on_sync, on_command=None):
        if self.mqtt_error is not None:
            self.calls.append("mqtt.factory-error")
            raise self.mqtt_error
        link = FakeMqtt(self.calls, settings, panel_code, token, on_sync, on_command)
        self.links.append(link)
        return link

    def worker_factory(self, api):
        worker = FakeWorker(api)
        self.workers.append(worker)
        return worker

    def runner(self, engine_factory=None):
        return Runner(self.settings, self.db_path, self.api, engine_factory or self.engine_factory,
                      self.mqtt_factory, clock=self.clock, sleep=self.clock.sleep, wall=self.clock,
                      command_worker_factory=self.worker_factory)

    def started(self, engine_factory=None):
        runner = self.runner(engine_factory)
        runner.start()
        return runner

    def run_for(self, runner, seconds, step=1):
        end = self.clock.now + seconds
        while self.clock.now < end:
            runner.tick()
            self.clock.now += step

    def preset_active(self, adopted=True, reconciled=True):
        """Panel ya vinculado y activo, como tras un reinicio del servicio."""
        ensure_identity(self.conn)
        save_credentials(self.env_path, CODE, TOKEN)
        set_state(self.conn, "state", "active")
        if adopted:
            set_state(self.conn, "adopted", "1")
        if reconciled:
            set_state(self.conn, "last_reconcile_at", str(int(self.clock.now)))

    def state(self, key="state"):
        return get_state(self.conn, key)

    def count(self, name):
        return self.calls.count(name)

    def cycles(self):
        return self.calls.count("push")


@pytest.fixture
def h(tmp_path, conn):
    return Harness(tmp_path, conn)


CYCLE = ["push", "pull", "upload_logs"]


# --- recorrido completo -----------------------------------------------------------------------

def test_full_walk_unlinked_to_staging_to_active_in_order(h):
    h.api.activate_result = Seq("token")
    h.api.import_result = Seq("active")
    runner = h.started()
    h.run_for(runner, 5)
    assert h.calls == ["register", "activate", "mqtt.start", "import_snapshot", "adopt_cloud"] + CYCLE
    assert h.state() == "active"
    assert h.state("adopted") == "1"
    assert h.state("last_reconcile_at") is not None   # adoptar cuenta como reconciliar
    assert h.state("installation_id") == "inst-1"
    assert h.state("installation_name") == "Fraccionamiento Demo"
    assert load_credentials(h.env_path) == (ensure_identity(h.conn).panel_code, TOKEN)
    assert h.api.auth == (ensure_identity(h.conn).panel_code, TOKEN)
    assert h.links[0].args[1:] == (ensure_identity(h.conn).panel_code, TOKEN)


def test_register_sends_the_identity_and_versions(h):
    runner = h.started()
    runner.tick()
    claim, versions = h.api.registered[0]
    assert claim == ensure_identity(h.conn).claim_code
    assert versions["schema_version"] == SCHEMA_VERSION
    assert isinstance(versions["software_version"], str) and versions["software_version"]


def test_the_snapshot_includes_every_replicated_table(h):
    h.api.activate_result = Seq("token")
    holders.create_holder(h.conn, HolderData(kind="persona", name="Ana", permission_ids=(0,)))
    runner = h.started()
    h.run_for(runner, 3)
    tables = h.api.snapshots[0]
    assert set(tables) == {"holders", "cards", "controls", "control_buttons", "permissions",
                           "holder_permissions", "outputs"}
    assert [r["data"]["name"] for r in tables["holders"]] == ["Ana"]


def test_pending_registers_every_30s_and_activates_every_10s(h):
    runner = h.started()
    h.run_for(runner, 65)
    assert h.count("register") == 3   # t = 0, 30, 60
    assert h.count("activate") == 7   # t = 0, 10, ..., 60
    assert h.state() == "unlinked"


def test_awaiting_review_polls_link_state_every_30s_until_active(h):
    h.api.activate_result = Seq("token")
    h.api.import_result = Seq("awaiting_review")
    h.api.link_result = Seq("awaiting_review", "awaiting_review", "active")
    runner = h.started()
    h.run_for(runner, 3)
    assert h.state() == "awaiting_review" and h.count("link_state") == 0
    h.run_for(runner, 28)   # todavía no pasan 30 s desde que quedó en revisión
    assert h.count("link_state") == 0
    h.run_for(runner, 5)
    assert h.count("link_state") == 1
    h.run_for(runner, 30)
    assert h.count("link_state") == 2 and h.state() == "awaiting_review"
    h.run_for(runner, 30)
    assert h.state() == "active" and h.count("adopt_cloud") == 1 and h.cycles() == 1


def test_adopt_cloud_runs_only_once_even_after_a_restart(h):
    h.api.activate_result = Seq("token")
    runner = h.started()
    h.run_for(runner, 5)
    assert h.count("adopt_cloud") == 1
    runner.close()
    h.calls.clear()
    again = h.started()
    h.run_for(again, 3)
    assert h.calls == ["mqtt.start"] + CYCLE


def test_adopt_failure_is_retried_and_not_marked_as_done(h):
    h.preset_active(adopted=False)
    h.engine.script["adopt_cloud"] = Seq(CloudError(0, "network_error", "ConnectError"), None)
    runner = h.started()
    h.run_for(runner, 5)
    assert h.count("adopt_cloud") == 1 and h.cycles() == 0
    assert h.state("adopted") is None and "ConnectError" in h.state("last_error")
    h.run_for(runner, 30)
    assert h.count("adopt_cloud") == 2 and h.state("adopted") == "1" and h.cycles() == 1


def test_import_conflict_is_resolved_by_asking_link_state(h):
    h.api.activate_result = Seq("token")
    h.api.import_result = Seq(CloudError(409, "invalid_state", "ya importado"))
    h.api.link_result = Seq("awaiting_review")
    runner = h.started()
    h.run_for(runner, 5)
    assert h.state() == "awaiting_review"
    assert h.calls[-2:] == ["import_snapshot", "link_state"]


def test_import_network_error_is_retried_after_30s(h):
    h.api.activate_result = Seq("token")
    h.api.import_result = Seq(CloudError(0, "network_error", "ConnectError"), "awaiting_review")
    runner = h.started()
    h.run_for(runner, 20)
    assert h.count("import_snapshot") == 1 and h.state() == "staging"
    assert "ConnectError" in h.state("last_error")
    h.run_for(runner, 20)
    assert h.count("import_snapshot") == 2 and h.state() == "awaiting_review"
    assert h.state("last_error") is None


# --- disparadores del ciclo activo --------------------------------------------------------------

def test_periodic_cycle_every_sync_interval(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, SYNC_INTERVAL_S - 5)
    assert h.cycles() == 1
    h.run_for(runner, 10)
    assert h.cycles() == 2
    h.run_for(runner, SYNC_INTERVAL_S - 5)
    assert h.cycles() == 2
    h.run_for(runner, 10)
    assert h.cycles() == 3


def test_a_newer_mqtt_notice_triggers_a_cycle(h):
    h.preset_active()
    set_state(h.conn, "cloud_revision", "10")
    runner = h.started()
    h.run_for(runner, 3)
    h.calls.clear()
    h.links[0].on_sync(11)
    h.run_for(runner, 3)
    assert h.calls == CYCLE


def test_a_notice_not_newer_than_cloud_revision_is_ignored(h):
    h.preset_active()
    set_state(h.conn, "cloud_revision", "10")
    runner = h.started()
    h.run_for(runner, 3)
    h.calls.clear()
    h.links[0].on_sync(10)
    h.links[0].on_sync(3)
    h.run_for(runner, 20)
    assert h.calls == []


def test_five_notices_during_a_cycle_leave_a_single_pending_cycle(h):
    h.preset_active()
    set_state(h.conn, "cloud_revision", "10")
    fired = []

    def burst():
        if not fired:
            fired.append(True)
            for revision in (11, 12, 13, 14, 15):
                h.links[0].on_sync(revision)

    h.engine.hooks["pull"] = burst
    runner = h.started()
    h.run_for(runner, 30)
    assert h.cycles() == 2 and h.count("pull") == 2
    h.run_for(runner, 60)
    assert h.cycles() == 2


def test_new_outbox_entries_trigger_a_cycle_within_the_poll_interval(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 3)
    assert h.cycles() == 1
    h.conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                   " VALUES ('c1', 'holders', 'upsert', 'u1', 1)")
    h.run_for(runner, OUTBOX_POLL_S + 1)
    assert h.cycles() == 2


def test_a_stuck_outbox_does_not_cause_a_cycle_loop(h):
    h.preset_active()
    h.conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                   " VALUES ('c1', 'holders', 'upsert', 'u1', 1)")
    h.engine.script["push"] = Seq(CloudError(400, "invalid_body", "cuerpo inválido"))
    runner = h.started()
    h.run_for(runner, 120)
    assert h.cycles() == 1   # la entrada atascada ya no es "nueva"
    h.conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                   " VALUES ('c2', 'holders', 'upsert', 'u2', 2)")
    h.run_for(runner, OUTBOX_POLL_S + 1)
    assert h.cycles() == 2


def test_reconcile_runs_every_reconcile_interval_between_pull_and_logs(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, RECONCILE_INTERVAL_S - 100, step=100)
    assert h.count("reconcile") == 0
    h.calls.clear()
    h.run_for(runner, 400, step=100)
    assert h.count("reconcile") == 1
    first = h.calls.index("reconcile")
    assert h.calls[first - 1] == "pull" and h.calls[first + 1] == "upload_logs"
    h.run_for(runner, RECONCILE_INTERVAL_S - 500, step=100)
    assert h.count("reconcile") == 1
    h.run_for(runner, 1000, step=100)
    assert h.count("reconcile") == 2


# --- revocación ---------------------------------------------------------------------------------

def test_an_outbox_entry_requeued_by_the_push_itself_does_not_loop_the_cycle(h):
    """Un rechazo «relacionado no existe» re-encola la entrada con un seq nuevo durante el push."""
    h.preset_active()

    def requeue():
        h.conn.execute("DELETE FROM sync_outbox")
        h.conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                       " VALUES (lower(hex(randomblob(16))), 'cards', 'upsert', 'u1', 1)")

    h.conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                   " VALUES ('a', 'cards', 'upsert', 'u1', 1)")
    h.engine.hooks["push"] = requeue
    runner = h.started()
    h.run_for(runner, 120)
    assert h.cycles() == 1
    h.conn.execute("INSERT INTO sync_outbox(change_id, table_name, op, row_uuid, updated_at)"
                   " VALUES ('b', 'holders', 'upsert', 'u2', 2)")   # una edición local nueva sí dispara
    h.run_for(runner, OUTBOX_POLL_S + 1)
    assert h.cycles() == 2


def test_restarts_before_the_interval_do_not_postpone_reconcile_forever(h):
    h.preset_active()
    first = h.started()
    h.run_for(first, 50000, step=100)
    first.close()
    assert h.count("reconcile") == 0
    second = h.started()   # reinicio: el reloj monotónico "vuelve a cero", la hora de pared no
    h.run_for(second, 40000, step=100)
    assert h.count("reconcile") == 1
    assert int(h.state("last_reconcile_at")) > 1000 + RECONCILE_INTERVAL_S - 1
    second.close()


def test_reconcile_runs_in_the_first_cycle_when_it_never_ran(h):
    h.preset_active(reconciled=False)
    runner = h.started()
    h.run_for(runner, 2)
    assert h.calls == ["mqtt.start", "push", "pull", "reconcile", "upload_logs"]
    assert h.state("last_reconcile_at") == "1000"


def test_reconcile_runs_after_start_if_it_is_already_overdue(h):
    h.preset_active()
    h.clock.now += RECONCILE_INTERVAL_S + 1
    runner = h.started()
    h.run_for(runner, 2)
    assert h.count("reconcile") == 1


def test_a_clock_that_went_back_does_not_block_reconcile(h):
    h.preset_active()
    set_state(h.conn, "last_reconcile_at", str(int(h.clock.now) + 10 * RECONCILE_INTERVAL_S))
    runner = h.started()
    h.run_for(runner, 2)
    assert h.count("reconcile") == 1


def test_a_failed_reconcile_is_not_recorded_and_is_retried_next_cycle(h):
    h.preset_active(reconciled=False)
    h.engine.script["reconcile"] = Seq(CloudError(0, "network_error", "ConnectError"), None)
    runner = h.started()
    h.run_for(runner, 2)
    assert h.count("reconcile") == 1 and h.state("last_reconcile_at") is None
    h.run_for(runner, SYNC_INTERVAL_S + 5)
    assert h.count("reconcile") == 2 and h.state("last_reconcile_at") is not None


@pytest.mark.parametrize("step", ["push", "pull", "upload_logs", "reconcile", "adopt_cloud"])
def test_a_401_returns_to_unlinked_with_a_new_claim_code_and_no_credentials(h, step):
    holders.create_holder(h.conn, HolderData(kind="persona", name="Ana", permission_ids=(0,)))
    h.preset_active(adopted=step != "adopt_cloud")
    old_claim = ensure_identity(h.conn).claim_code
    h.engine.script[step] = Seq(CloudError(401, "unauthorized", "Credencial inválida"))
    runner = h.started()
    if step == "reconcile":
        h.run_for(runner, RECONCILE_INTERVAL_S + 10, step=100)   # hasta que vence la reconciliación
    else:
        h.run_for(runner, 2)
    assert h.state() == "unlinked" and h.state("adopted") is None
    assert ensure_identity(h.conn).claim_code != old_claim
    assert load_credentials(h.env_path) is None
    text = h.env_path.read_text()
    assert TOKEN not in text and "CLOUD_URL=%s" % CLOUD_URL in text
    assert "mqtt.stop" in h.calls
    assert h.conn.execute("SELECT COUNT(*) FROM holders").fetchone()[0] == 1   # datos intactos
    h.run_for(runner, 2)   # sin vincular, vuelve a registrarse con el código nuevo
    assert "register" in h.calls
    assert h.api.registered[-1][0] == ensure_identity(h.conn).claim_code


def test_leaving_active_forgets_the_backup_of_an_unfinished_adoption(h):
    h.preset_active(adopted=False)
    set_state(h.conn, ADOPT_BACKUP_KEY, "1")   # un intento anterior ya respaldó y falló
    h.engine.script["adopt_cloud"] = Seq(CloudError(401, "unauthorized"))
    runner = h.started()
    h.run_for(runner, 2)
    assert h.state() == "unlinked"
    assert h.state(ADOPT_BACKUP_KEY) is None   # la próxima adopción vuelve a respaldar


@pytest.mark.parametrize("stage", ["import_result", "link_result"])
def test_a_401_in_staging_or_review_also_revokes(h, stage):
    old_claim = ensure_identity(h.conn).claim_code
    h.api.activate_result = Seq("token", None)
    if stage == "import_result":
        h.api.import_result = Seq(CloudError(401, "unauthorized"))
    else:
        h.api.import_result = Seq("awaiting_review")
        h.api.link_result = Seq(CloudError(401, "unauthorized"))
    runner = h.started()
    h.run_for(runner, 40)
    assert h.state() == "unlinked"
    assert load_credentials(h.env_path) is None
    assert ensure_identity(h.conn).claim_code != old_claim
    assert h.calls.count("mqtt.stop") == 1


@pytest.mark.parametrize("step", ["push", "pull", "upload_logs", "reconcile", "adopt_cloud"])
def test_a_401_that_is_not_from_the_cloud_does_not_revoke(h, step):
    """Un 401 sin el código `unauthorized` de la nube (proxy, protección de Vercel, portal cautivo) es
    un error de red: se anota y se reintenta, sin borrar la credencial."""
    h.preset_active(adopted=step != "adopt_cloud")
    old_claim = ensure_identity(h.conn).claim_code
    h.engine.script[step] = Seq(CloudError(401, "http_error"), None)
    runner = h.started()
    if step == "reconcile":
        h.run_for(runner, RECONCILE_INTERVAL_S + 10, step=100)
    else:
        h.run_for(runner, 2)
    assert h.state() == "active"
    assert load_credentials(h.env_path) == (CODE, TOKEN)
    assert ensure_identity(h.conn).claim_code == old_claim
    assert "mqtt.stop" not in h.calls
    assert "401" in h.state("last_error")
    h.run_for(runner, SYNC_INTERVAL_S + RETRY_S + 5)   # se reintenta y se recupera
    assert h.count(step) >= 2 and h.state() == "active"


@pytest.mark.parametrize("stage", ["import_result", "link_result"])
def test_a_401_that_is_not_from_the_cloud_in_staging_or_review_does_not_revoke(h, stage):
    old_claim = ensure_identity(h.conn).claim_code
    h.api.activate_result = Seq("token", None)
    if stage == "import_result":
        h.api.import_result = Seq(CloudError(401, "http_error"))
        expected = "staging"
    else:
        h.api.import_result = Seq("awaiting_review")
        h.api.link_result = Seq(CloudError(401, "http_error"))
        expected = "awaiting_review"
    runner = h.started()
    h.run_for(runner, 40)
    assert h.state() == expected
    assert load_credentials(h.env_path) is not None
    assert ensure_identity(h.conn).claim_code == old_claim
    assert "mqtt.stop" not in h.calls
    assert "401" in h.state("last_error")


def test_a_revoked_activation_regenerates_the_claim_code_and_registers_again(h):
    old_claim = ensure_identity(h.conn).claim_code
    h.api.activate_result = Seq(CloudError(410, "revoked", "revocado"), None)
    runner = h.started()
    runner.tick()
    assert ensure_identity(h.conn).claim_code != old_claim
    h.clock.now += 1
    runner.tick()   # register no espera 30 s: la nube ya no conoce el código viejo
    assert h.calls == ["register", "activate", "register"]
    assert h.api.registered[1][0] == ensure_identity(h.conn).claim_code
    assert h.state() == "unlinked"


def test_activate_unauthorized_forces_a_new_register(h):
    h.api.activate_result = Seq(CloudError(401, "unauthorized"), None)
    runner = h.started()
    runner.tick()
    h.clock.now += 1
    runner.tick()
    assert h.calls == ["register", "activate", "register"]
    assert h.state() == "unlinked"


def test_already_activated_without_credentials_stays_unlinked_and_keeps_polling(h):
    old_claim = ensure_identity(h.conn).claim_code
    h.api.activate_result = Seq(CloudError(409, "already_activated", "ya se activó"))
    runner = h.started()
    h.run_for(runner, 35)
    assert h.state() == "unlinked" and h.state("last_error") == ALREADY_ACTIVATED
    assert ensure_identity(h.conn).claim_code == old_claim
    assert h.count("activate") == 4 and h.count("register") == 2


# --- errores y recuperación -----------------------------------------------------------------------

def test_a_network_error_in_pull_does_not_stop_the_runner_and_the_next_cycle_retries(h):
    h.preset_active()
    h.engine.script["pull"] = Seq(CloudError(0, "network_error", "ConnectError"), None)
    stop = Stop()
    end = h.clock.now + SYNC_INTERVAL_S + 10
    sleeper = h.clock.sleep

    def sleep(seconds):
        sleeper(seconds)
        if h.clock.now >= end:
            stop.set()

    runner = Runner(h.settings, h.db_path, h.api, h.engine_factory, h.mqtt_factory,
                    clock=h.clock, sleep=sleep, wall=h.clock)
    runner.run(stop)
    assert h.count("pull") == 2 and h.cycles() == 2
    # el fallo del pull no impidió la subida de logs de su ciclo
    assert h.count("upload_logs") == 2
    # el aviso del pull se guardó al terminar el primer ciclo y el segundo ciclo limpio lo borró
    assert h.state("last_error") is None
    assert "mqtt.stop" in h.calls   # al detenerse cierra el enlace MQTT


def test_a_failing_step_does_not_prevent_the_other_steps_of_the_cycle(h):
    h.preset_active()
    h.engine.script["push"] = Seq(CloudError(400, "invalid_body", "cuerpo inválido"))
    runner = h.started()
    h.run_for(runner, 3)
    assert h.calls[-3:] == CYCLE
    error = h.state("last_error")
    assert "400" in error and "invalid_body" in error


def test_last_error_is_cleared_after_a_clean_cycle(h):
    h.preset_active()
    h.engine.script["upload_logs"] = Seq(CloudError(500, "http_error", "falló"), None)
    runner = h.started()
    h.run_for(runner, 3)
    assert "500" in h.state("last_error")
    h.run_for(runner, SYNC_INTERVAL_S + 5)
    assert h.state("last_error") is None


def test_a_message_set_by_the_sync_engine_during_a_clean_cycle_is_kept(h):
    h.preset_active()
    h.engine.hooks["pull"] = lambda: set_state(h.conn, "last_error", "Mensaje del motor")
    runner = h.started()
    h.run_for(runner, 3)
    assert h.state("last_error") == "Mensaje del motor"


def test_mass_delete_block_is_reported_and_not_retried_in_a_tight_loop(h):
    h.preset_active()
    h.engine.script["pull"] = Seq(SyncBlocked("holders", 12, 20), None)
    runner = h.started()
    h.run_for(runner, 120)
    assert h.count("pull") == 1
    assert "Sincronización detenida" in h.state("last_error")
    h.run_for(runner, SYNC_INTERVAL_S)
    assert h.count("pull") == 2 and h.state("last_error") is None


def test_an_invalid_change_is_reported_and_the_rest_of_the_cycle_runs(h):
    h.preset_active()
    h.engine.script["pull"] = Seq(InvalidChange("La nube envió un cambio incompleto de cards."), None)
    runner = h.started()
    h.run_for(runner, 3)
    assert h.calls[-3:] == CYCLE
    assert h.state("last_error") == "La nube envió un cambio incompleto de cards."


def test_an_unexpected_exception_is_logged_without_its_text(h, caplog):
    h.preset_active()
    secret = ensure_identity(h.conn).panel_secret
    h.engine.script["push"] = Seq(RuntimeError("fallo con %s y %s" % (TOKEN, secret)))
    runner = h.started()
    with caplog.at_level(logging.DEBUG):
        h.run_for(runner, 3)
    assert h.calls[-3:] == CYCLE
    assert "RuntimeError" in h.state("last_error")
    for text in (TOKEN, secret):
        assert text not in h.state("last_error") and text not in caplog.text


def test_not_active_conflict_resyncs_the_state_with_link_state(h):
    h.preset_active()
    h.engine.script["push"] = Seq(CloudError(409, "not_active", "El panel no está activo"))
    h.api.link_result = Seq("staging")
    runner = h.started()
    h.run_for(runner, 1)
    assert h.calls[-2:] == ["push", "link_state"] and "pull" not in h.calls
    assert h.state() == "staging" and h.state("adopted") is None


def test_logs_never_contain_the_token_the_secret_or_the_claim_code(h, caplog):
    identity = ensure_identity(h.conn)
    h.api.activate_result = Seq("token")
    h.engine.script["pull"] = Seq(CloudError(500, "http_error", "falló"), None)
    runner = h.started()
    with caplog.at_level(logging.DEBUG):
        h.run_for(runner, 5)
        h.engine.script["upload_logs"] = Seq(CloudError(401, "unauthorized"))
        h.run_for(runner, SYNC_INTERVAL_S + 10)
    assert caplog.text  # sí se registra algo
    for text in (TOKEN, identity.panel_secret, identity.claim_code):
        assert text not in caplog.text


def test_without_cloud_url_nothing_is_called_and_the_error_says_so(tmp_path, conn):
    h = Harness(tmp_path, conn, cloud_url="", mqtt_url="")
    runner = h.started()
    h.run_for(runner, 60)
    assert h.calls == []
    assert "CLOUD_URL" in h.state("last_error")


# --- arranque ---------------------------------------------------------------------------------

def test_start_resets_the_sync_guard_through_the_engine(h):
    h.conn.execute("UPDATE sync_guard SET applying=1 WHERE id=1")
    runner = h.started(engine_factory=lambda db_path, api: SyncEngine(db_path, api))
    assert h.conn.execute("SELECT applying FROM sync_guard WHERE id=1").fetchone()[0] == 0
    runner.close()


def test_the_engine_is_created_once_at_start_with_db_path_and_api(h):
    runner = h.started()
    h.run_for(runner, 40)
    assert h.engine_factory_args == [(h.db_path, h.api)]


def test_active_state_without_credentials_goes_back_to_unlinked(h):
    ensure_identity(h.conn)
    set_state(h.conn, "state", "active")
    set_state(h.conn, "adopted", "1")
    h.started()
    assert h.state() == "unlinked" and h.state("adopted") is None


def test_credentials_with_state_unlinked_resume_in_staging(h):
    ensure_identity(h.conn)
    save_credentials(h.env_path, CODE, TOKEN)
    runner = h.started()
    assert h.state() == "staging" and h.api.auth == (CODE, TOKEN)
    h.run_for(runner, 3)
    assert h.calls[:2] == ["mqtt.start", "import_snapshot"]


def test_a_real_cycle_with_the_sync_engine_against_the_fake_cloud(h):
    """Runner + SyncEngine reales: lo local sube, lo de la nube baja y los logs se suben."""
    cloud = FakeCloud()
    h.preset_active()
    holders.create_holder(h.conn, HolderData(kind="persona", name="Ana", permission_ids=(0,)))
    runner = Runner(h.settings, h.db_path, cloud.api(), lambda db_path, api: SyncEngine(db_path, api),
                    h.mqtt_factory, clock=h.clock, sleep=h.clock.sleep, wall=h.clock)
    runner.start()
    runner.tick()
    assert [r["data"]["name"] for r in cloud.live("holders")] == ["Ana"]
    assert h.conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0] == 0
    assert h.state("last_error") is None
    assert [p for m, p, _, _ in cloud.requests][:2] == ["/changes", "/changes"]   # push y pull
    runner.close()


# --- MQTT -------------------------------------------------------------------------------------

def test_mqtt_failure_to_start_does_not_break_the_runner_and_is_retried_later(h, caplog):
    h.preset_active()
    h.mqtt_error = RuntimeError("fallo con %s" % TOKEN)
    runner = h.started()
    with caplog.at_level(logging.DEBUG):
        h.run_for(runner, 60)
        assert h.count("mqtt.factory-error") == 1 and h.cycles() == 1
        h.mqtt_error = None
        h.run_for(runner, SYNC_INTERVAL_S)
    assert h.count("mqtt.start") == 1
    assert TOKEN not in caplog.text


def test_without_mqtt_url_no_link_is_created(tmp_path, conn):
    h = Harness(tmp_path, conn, mqtt_url="")
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 5)
    assert h.links == [] and "mqtt.factory-error" not in h.calls and h.cycles() == 1


def test_the_link_is_stopped_on_revocation_and_recreated_on_the_next_activation(h):
    h.preset_active()
    h.engine.script["pull"] = Seq(CloudError(401, "unauthorized"))
    runner = h.started()
    h.run_for(runner, 2)
    assert h.calls.count("mqtt.start") == 1 and h.calls.count("mqtt.stop") == 1
    h.api.activate_result = Seq("token")
    h.engine.script["pull"] = Seq(None)
    h.run_for(runner, 15)
    assert h.calls.count("mqtt.start") == 2 and len(h.links) == 2


# --- órdenes de la nube (upload_logs y test_output) ---------------------------------------------

TEST_ORDER = {"type": "test_output", "command_id": "8f0c2a5e-1d2b-4c3d-9e4f-5a6b7c8d9e0f", "output": 1,
              "requested_by": "ana@example.com", "expires_at": "2027-01-15T08:00:10.000Z"}


def test_the_link_receives_on_command(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 1)
    assert h.links[0].on_command is not None


def test_upload_logs_order_uploads_on_the_next_tick_without_push_or_pull(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 3)
    h.calls.clear()
    h.links[0].on_command({"type": "upload_logs"})
    runner.tick()
    assert h.calls == ["upload_logs"] and h.engine.always_post[-1] is True
    h.run_for(runner, 5)
    assert h.calls == ["upload_logs"]   # la bandera se bajó: no se repite


def test_many_upload_logs_orders_before_a_tick_upload_once(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 3)
    h.calls.clear()
    for _ in range(5):
        h.links[0].on_command({"type": "upload_logs"})
    h.run_for(runner, 3)
    assert h.calls == ["upload_logs"]


def test_upload_logs_order_during_a_due_cycle_uploads_once_with_always_post(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 3)
    h.calls.clear()
    h.clock.now += SYNC_INTERVAL_S   # ya toca el ciclo
    h.links[0].on_command({"type": "upload_logs"})
    runner.tick()
    assert h.calls == CYCLE and h.engine.always_post[-1] is True
    h.run_for(runner, 3)
    assert h.calls == CYCLE


def test_upload_logs_order_failure_is_noted_and_does_not_break_the_runner(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 3)
    h.engine.script["upload_logs"] = Seq(CloudError(0, "network_error", "ConnectError"), None)
    h.links[0].on_command({"type": "upload_logs"})
    runner.tick()
    assert "Subida de logs" in h.state("last_error") and h.state() == "active"


def test_upload_logs_order_with_a_401_revokes(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 3)
    h.engine.script["upload_logs"] = Seq(CloudError(401, "unauthorized"))
    h.links[0].on_command({"type": "upload_logs"})
    runner.tick()
    assert h.state() == "unlinked" and load_credentials(h.env_path) is None


def test_upload_logs_order_not_active_resyncs_the_state(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 3)
    h.calls.clear()
    h.engine.script["upload_logs"] = Seq(CloudError(409, "not_active"))
    h.api.link_result = Seq("staging")
    h.links[0].on_command({"type": "upload_logs"})
    runner.tick()
    assert h.calls == ["upload_logs", "link_state"] and h.state() == "staging"


def test_test_output_order_in_active_is_submitted_to_the_worker(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 2)
    h.links[0].on_command(TEST_ORDER)
    assert h.workers[0].submitted == [TEST_ORDER]
    h.run_for(runner, 3)
    assert h.cycles() == 1 and h.count("upload_logs") == 1   # no dispara un ciclo ni una subida


def test_test_output_order_outside_active_is_not_submitted(h):
    ensure_identity(h.conn)
    save_credentials(h.env_path, CODE, TOKEN)
    h.api.import_result = Seq("awaiting_review")
    runner = h.started()
    h.run_for(runner, 2)
    assert h.state() == "awaiting_review"
    h.links[0].on_command(TEST_ORDER)
    assert h.workers[0].submitted == []


def test_the_worker_gets_its_own_authenticated_api_and_starts_once(h):
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 10)
    (worker,) = h.workers
    assert worker.events == ["start"]
    assert worker.api is not h.api
    assert worker.api._authorization == "Device %s.%s" % (CODE, TOKEN)
    runner.close()
    assert worker.events == ["start", "stop"]


def test_the_worker_is_stopped_on_revocation_and_recreated_with_the_new_credential(h):
    h.preset_active()
    h.engine.script["pull"] = Seq(CloudError(401, "unauthorized"))
    runner = h.started()
    h.run_for(runner, 2)
    assert h.workers[0].events == ["start", "stop"]
    h.api.activate_result = Seq("token")
    h.engine.script["pull"] = Seq(None)
    h.run_for(runner, 15)
    assert len(h.workers) == 2 and h.workers[1].events == ["start"]


def test_without_mqtt_url_no_worker_is_created(tmp_path, conn):
    h = Harness(tmp_path, conn, mqtt_url="")
    h.preset_active()
    runner = h.started()
    h.run_for(runner, 5)
    assert h.workers == [] and h.cycles() == 1
    runner.close()


def test_without_a_worker_factory_a_test_output_order_is_ignored(h):
    h.preset_active()
    runner = Runner(h.settings, h.db_path, h.api, h.engine_factory, h.mqtt_factory,
                    clock=h.clock, sleep=h.clock.sleep, wall=h.clock)
    runner.start()
    h.run_for(runner, 2)
    h.links[0].on_command(TEST_ORDER)   # no lanza
    runner.close()


def test_a_failing_worker_factory_does_not_break_the_runner(h, caplog):
    h.preset_active()

    def explode(api):
        raise RuntimeError("fallo con %s" % TOKEN)

    runner = Runner(h.settings, h.db_path, h.api, h.engine_factory, h.mqtt_factory,
                    clock=h.clock, sleep=h.clock.sleep, wall=h.clock, command_worker_factory=explode)
    runner.start()
    with caplog.at_level(logging.DEBUG):
        h.run_for(runner, 3)
    assert h.cycles() == 1 and TOKEN not in caplog.text
    runner.close()


# --- bucle y arranque del proceso ---------------------------------------------------------------

def test_run_stops_when_asked_and_closes_the_link(h):
    h.preset_active()
    stop = Stop()
    runner = Runner(h.settings, h.db_path, h.api, h.engine_factory, h.mqtt_factory, clock=h.clock,
                    sleep=lambda s: stop.set(), wall=h.clock)
    runner.run(stop)
    assert h.calls == ["mqtt.start"] + CYCLE + ["mqtt.stop"]


def test_tick_never_raises(h, monkeypatch):
    runner = h.started()
    monkeypatch.setattr(runner, "_unlinked", lambda now: (_ for _ in ()).throw(sqlite3.OperationalError("locked")))
    runner.tick()   # no lanza
    assert "OperationalError" in h.state("last_error")


def test_main_migrates_before_starting_the_runner(tmp_path, monkeypatch):
    from acceso.cloud import __main__ as entry

    db = tmp_path / "data" / "panel.sqlite"
    env = {"ACCESO_ENV_FILE": str(tmp_path / "ninguno.env"), "DB_PATH": str(db),
           "CLOUD_URL": CLOUD_URL, "MQTT_URL": MQTT_URL,
           "CLOUD_CREDENTIALS_PATH": str(tmp_path / "cloud.env")}
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(entry.signal, "signal", lambda *a: None)
    started = []

    def fake_run(self, stop):
        started.append(Path(str(self._db_path)).exists() and sqlite3.connect(str(db)).execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='sync_state'").fetchone()[0])

    monkeypatch.setattr(entry.Runner, "run", fake_run)
    entry.main()
    assert started == [1]


def test_main_builds_the_command_worker_with_the_daemon_socket_and_its_own_api(tmp_path, monkeypatch):
    from acceso.cloud import __main__ as entry
    from acceso.cloud.api import CloudApi
    from acceso.cloud.commands import CommandWorker

    for key, value in {"ACCESO_ENV_FILE": str(tmp_path / "ninguno.env"),
                       "DB_PATH": str(tmp_path / "p.sqlite"), "CLOUD_URL": CLOUD_URL,
                       "CLOUD_CREDENTIALS_PATH": str(tmp_path / "cloud.env"),
                       "DAEMON_SOCKET": str(tmp_path / "daemon.sock")}.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(entry.signal, "signal", lambda *a: None)
    built = []

    def fake_run(self, stop):
        api = CloudApi(CLOUD_URL)
        built.append((self._command_worker_factory(api), api))

    monkeypatch.setattr(entry.Runner, "run", fake_run)
    entry.main()
    (worker, api), = built
    assert isinstance(worker, CommandWorker)
    assert worker._socket_path == str(tmp_path / "daemon.sock")
    assert worker._post_result == api.post_command_result


def test_main_reports_an_invalid_configuration_in_spanish(tmp_path, monkeypatch, caplog):
    from acceso.cloud import __main__ as entry

    monkeypatch.setenv("ACCESO_ENV_FILE", str(tmp_path / "ninguno.env"))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "p.sqlite"))
    monkeypatch.setenv("CLOUD_CREDENTIALS_PATH", str(tmp_path / "cloud.env"))
    monkeypatch.setenv("CLOUD_URL", "ftp://raro")
    with caplog.at_level(logging.ERROR), pytest.raises(SystemExit) as exc:
        entry.main()
    assert exc.value.code == 1 and "CLOUD_URL" in caplog.text


@pytest.mark.parametrize("raw, expected", [
    (None, 300), ("", 300), ("20", 20), (" 45 ", 45), ("abc", 300), ("0", 300), ("-5", 300),
])
def test_interval_from_env_falls_back_to_the_default(monkeypatch, raw, expected):
    from acceso.cloud.runner import interval_from_env

    if raw is None:
        monkeypatch.delenv("SYNC_INTERVAL_S", raising=False)
    else:
        monkeypatch.setenv("SYNC_INTERVAL_S", raw)
    assert interval_from_env("SYNC_INTERVAL_S", 300) == expected
