"""Enlace MQTT del agente acceso-cloud, con un cliente paho falso (nunca un broker real)."""
import json
import logging
from pathlib import Path

import paho.mqtt.client as paho
import pytest

from acceso.cloud.config import CloudSettings
from acceso.cloud.mqtt_link import UNKNOWN_REVISION, MqttLink
from acceso.config import ConfigError

CODE = "PNL-0123-4ABC"
TOKEN = "T" * 43
CMD = "acc/%s/cmd" % CODE
STATUS = "acc/%s/status" % CODE


class FakeReason:
    def __init__(self, failure=False):
        self.is_failure = failure

    def __str__(self):
        return "Not authorized" if self.is_failure else "Success"


class FakeMessage:
    def __init__(self, topic, payload):
        self.topic = topic
        self.payload = payload if isinstance(payload, bytes) else json.dumps(payload).encode()


class FakeClient:
    """Registra lo que MqttLink le pide; los callbacks se disparan a mano desde la prueba."""

    def __init__(self, *args, **kwargs):
        self.init = (args, kwargs)
        self.calls = []
        self.on_connect = self.on_message = self.on_disconnect = None

    def _record(self, name, *args, **kwargs):
        self.calls.append((name, args, kwargs))

    def args_of(self, name):
        return [(a, k) for n, a, k in self.calls if n == name]

    def username_pw_set(self, *a, **k):
        self._record("username_pw_set", *a, **k)

    def tls_set(self, *a, **k):
        self._record("tls_set", *a, **k)

    def will_set(self, *a, **k):
        self._record("will_set", *a, **k)

    def reconnect_delay_set(self, *a, **k):
        self._record("reconnect_delay_set", *a, **k)

    def connect_async(self, *a, **k):
        self._record("connect_async", *a, **k)

    def loop_start(self):
        self._record("loop_start")

    def loop_stop(self):
        self._record("loop_stop")

    def disconnect(self):
        self._record("disconnect")

    def subscribe(self, *a, **k):
        self._record("subscribe", *a, **k)

    def publish(self, *a, **k):
        self._record("publish", *a, **k)
        return self

    def wait_for_publish(self, timeout=None):
        self._record("wait_for_publish")


def settings(mqtt_url="mqtts://mqtt.example.com:8883"):
    return CloudSettings("https://nube.example.com", mqtt_url, Path("/tmp/no-se-usa.env"))


def make_link(on_sync=None, mqtt_url="mqtts://mqtt.example.com:8883", on_command=None):
    clients = []

    def factory(*args, **kwargs):
        clients.append(FakeClient(*args, **kwargs))
        return clients[-1]

    received = []
    link = MqttLink(settings(mqtt_url), CODE, TOKEN, on_sync or received.append, on_command=on_command,
                    client_factory=factory)
    return link, clients, received


def test_start_configures_tls_credentials_will_and_reconnect():
    link, clients, _ = make_link()
    link.start()
    client = clients[0]
    args, kwargs = client.init
    assert args == (paho.CallbackAPIVersion.VERSION2,) and kwargs == {"client_id": CODE}
    assert client.args_of("username_pw_set") == [((CODE, TOKEN), {})]
    assert len(client.args_of("tls_set")) == 1
    (will_args, will_kwargs), = client.args_of("will_set")
    assert (will_args, will_kwargs) == ((STATUS,), {"payload": "offline", "qos": 1, "retain": True})
    assert client.args_of("reconnect_delay_set") == [((), {"min_delay": 10, "max_delay": 10})]
    assert client.args_of("connect_async")[0][0][:2] == ("mqtt.example.com", 8883)
    assert [n for n, _, _ in client.calls].count("loop_start") == 1


def test_default_port_is_8883():
    link, clients, _ = make_link(mqtt_url="mqtts://mqtt.example.com")
    link.start()
    assert clients[0].args_of("connect_async")[0][0][:2] == ("mqtt.example.com", 8883)


@pytest.mark.parametrize("url", ["", "mqtt://mqtt.example.com:1883", "http://x", "mqtts://", "mqtts://x:abc"])
def test_invalid_mqtt_url_is_rejected_in_spanish(url):
    with pytest.raises(ConfigError, match="MQTT_URL"):
        MqttLink(settings(url), CODE, TOKEN, lambda r: None, client_factory=FakeClient)


def test_on_connect_publishes_retained_online_and_subscribes_to_cmd():
    link, clients, _ = make_link()
    link.start()
    client = clients[0]
    client.on_connect(client, None, {}, FakeReason(), None)
    assert client.args_of("publish") == [((STATUS,), {"payload": "online", "qos": 1, "retain": True})]
    assert client.args_of("subscribe") == [((CMD,), {"qos": 1})]
    assert link.connected


def test_on_connect_rejected_does_not_subscribe(caplog):
    link, clients, _ = make_link()
    link.start()
    client = clients[0]
    with caplog.at_level(logging.INFO):
        client.on_connect(client, None, {}, FakeReason(failure=True), None)
    assert not client.args_of("subscribe") and not client.args_of("publish")
    assert not link.connected
    assert TOKEN not in caplog.text


def test_on_disconnect_marks_not_connected():
    link, clients, _ = make_link()
    link.start()
    client = clients[0]
    client.on_connect(client, None, {}, FakeReason(), None)
    client.on_disconnect(client, None, {}, FakeReason(failure=True), None)
    assert not link.connected


def test_sync_message_calls_on_sync_with_its_revision():
    link, clients, received = make_link()
    link.start()
    clients[0].on_message(clients[0], None, FakeMessage(CMD, {"type": "sync", "revision": 42}))
    assert received == [42]


def test_sync_message_without_a_valid_revision_is_never_considered_old():
    link, clients, received = make_link()
    link.start()
    for payload in ({"type": "sync"}, {"type": "sync", "revision": "x"}, {"type": "sync", "revision": True}):
        clients[0].on_message(clients[0], None, FakeMessage(CMD, payload))
    assert received == [UNKNOWN_REVISION] * 3


@pytest.mark.parametrize("message", [
    FakeMessage(CMD, {"type": "otra-cosa", "revision": 5}),
    FakeMessage(CMD, [1, 2]),
    FakeMessage(CMD, b"no es json"),
    FakeMessage(CMD, b"\xff\xfe"),
    FakeMessage("acc/PNL-9999-9999/cmd", {"type": "sync", "revision": 5}),
])
def test_other_messages_are_ignored(message):
    link, clients, received = make_link()
    link.start()
    clients[0].on_message(clients[0], None, message)
    assert received == []


TEST_OUTPUT = {"type": "test_output", "command_id": "8f0c2a5e-1d2b-4c3d-9e4f-5a6b7c8d9e0f", "output": 1,
               "requested_by": "ana@example.com", "expires_at": "2027-01-15T08:00:10.000Z"}


@pytest.mark.parametrize("payload", [{"type": "upload_logs"}, TEST_OUTPUT])
def test_command_messages_reach_on_command_with_their_body(payload):
    commands = []
    link, clients, received = make_link(on_command=commands.append)
    link.start()
    clients[0].on_message(clients[0], None, FakeMessage(CMD, payload))
    assert commands == [payload] and received == []


def test_unknown_types_do_not_reach_on_command_and_sync_still_reaches_on_sync():
    commands = []
    link, clients, received = make_link(on_command=commands.append)
    link.start()
    for payload in ({"type": "open_door", "output": 1}, {"type": 5}, {"output": 1},
                    {"type": "sync", "revision": 9}):
        clients[0].on_message(clients[0], None, FakeMessage(CMD, payload))
    assert commands == [] and received == [9]


def test_command_messages_are_ignored_without_on_command():
    link, clients, received = make_link()
    link.start()
    clients[0].on_message(clients[0], None, FakeMessage(CMD, {"type": "upload_logs"}))
    assert received == []


def test_command_messages_on_another_topic_are_ignored():
    commands = []
    link, clients, _ = make_link(on_command=commands.append)
    link.start()
    clients[0].on_message(clients[0], None, FakeMessage("acc/PNL-9999-9999/cmd", {"type": "upload_logs"}))
    assert commands == []


def test_a_failing_on_command_only_logs_the_exception_type(caplog):
    def explode(body):
        raise RuntimeError("detalle con %s" % TOKEN)

    link, clients, _ = make_link(on_command=explode)
    link.start()
    with caplog.at_level(logging.DEBUG):
        clients[0].on_message(clients[0], None, FakeMessage(CMD, {"type": "upload_logs"}))
    assert "RuntimeError" in caplog.text and TOKEN not in caplog.text


def test_a_failing_on_sync_does_not_break_the_mqtt_thread(caplog):
    def explode(revision):
        raise RuntimeError("detalle con %s" % TOKEN)

    link, clients, _ = make_link(on_sync=explode)
    link.start()
    with caplog.at_level(logging.DEBUG):
        clients[0].on_message(clients[0], None, FakeMessage(CMD, {"type": "sync", "revision": 1}))
    assert TOKEN not in caplog.text


def test_stop_publishes_offline_and_disconnects():
    link, clients, _ = make_link()
    link.start()
    client = clients[0]
    client.on_connect(client, None, {}, FakeReason(), None)
    client.calls.clear()
    link.stop()
    assert client.args_of("publish") == [((STATUS,), {"payload": "offline", "qos": 1, "retain": True})]
    names = [n for n, _, _ in client.calls]
    assert names.index("publish") < names.index("disconnect") < names.index("loop_stop")
    assert not link.connected


def test_stop_while_never_connected_just_closes():
    link, clients, _ = make_link()
    link.start()
    link.stop()
    names = [n for n, _, _ in clients[0].calls]
    assert "publish" not in names and names[-2:] == ["disconnect", "loop_stop"]


def test_stop_without_start_does_nothing():
    link, clients, _ = make_link()
    link.stop()
    assert clients == []


def test_works_with_the_real_paho_client_api(monkeypatch):
    """Los métodos que usa MqttLink existen en paho 2.x con esos argumentos (sin red)."""
    for name in ("connect_async", "loop_start", "loop_stop", "disconnect"):
        monkeypatch.setattr(paho.Client, name, lambda self, *a, **k: None)
    monkeypatch.setattr(paho.Client, "publish", lambda self, *a, **k: type(
        "Info", (), {"wait_for_publish": lambda self, timeout=None: None})())
    link = MqttLink(settings(), CODE, TOKEN, lambda r: None)
    link.start()
    link.stop()
