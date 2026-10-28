"""Enlace MQTT del agente acceso-cloud: recibe avisos de la nube (`acc/<panel_code>/cmd`).

MQTT es solo un aviso para sincronizar antes: si no conecta, la sincronización periódica sigue
funcionando. Usuario MQTT = panel_code y contraseña = device_token (los verifica la nube por HTTP).
El token nunca se registra. La conexión es siempre TLS (`mqtts://`).
"""
import json
import logging
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

import paho.mqtt.client as paho

from acceso.cloud.config import CloudSettings
from acceso.config import ConfigError

log = logging.getLogger("acceso.cloud")

DEFAULT_PORT = 8883
KEEPALIVE_S = 60
RECONNECT_S = 10
PUBLISH_WAIT_S = 2.0
# Aviso sin revisión válida: nunca se considera viejo.
UNKNOWN_REVISION = 2 ** 63 - 1


def _parse_url(mqtt_url: str):
    parts = urlsplit(mqtt_url or "")
    try:
        port = parts.port or DEFAULT_PORT
    except ValueError:
        port = None
    if parts.scheme != "mqtts" or not parts.hostname or port is None:
        raise ConfigError("MQTT_URL debe tener la forma mqtts://servidor:puerto (conexión con TLS)")
    return parts.hostname, port


class MqttLink:
    def __init__(self, settings: CloudSettings, panel_code: str, token: str,
                 on_sync: Callable[[int], None],
                 client_factory: Callable[..., Any] = paho.Client):
        self._host, self._port = _parse_url(settings.mqtt_url)
        self._panel_code = panel_code
        self._token = token
        self._on_sync = on_sync
        self._factory = client_factory
        self._client = None  # type: Optional[Any]
        self._connected = False
        self._cmd_topic = "acc/%s/cmd" % panel_code
        self._status_topic = "acc/%s/status" % panel_code

    @property
    def connected(self) -> bool:
        return self._connected

    def start(self) -> None:
        """Configura el cliente y conecta en segundo plano; paho reintenta cada RECONNECT_S."""
        client = self._factory(paho.CallbackAPIVersion.VERSION2, client_id=self._panel_code)
        client.username_pw_set(self._panel_code, self._token)
        client.tls_set()
        client.will_set(self._status_topic, payload="offline", qos=1, retain=True)
        client.reconnect_delay_set(min_delay=RECONNECT_S, max_delay=RECONNECT_S)
        client.on_connect = self._handle_connect
        client.on_disconnect = self._handle_disconnect
        client.on_message = self._handle_message
        self._client = client
        client.connect_async(self._host, self._port, KEEPALIVE_S)
        client.loop_start()

    def stop(self) -> None:
        """Avisa `offline` (una desconexión limpia no dispara el LWT) y cierra la conexión."""
        client, self._client = self._client, None
        if client is None:
            return
        try:
            if self._connected:
                client.publish(self._status_topic, payload="offline", qos=1, retain=True).wait_for_publish(
                    timeout=PUBLISH_WAIT_S)
        except Exception as exc:  # no impide cerrar
            log.warning("No se pudo publicar el estado offline por MQTT (%s)", type(exc).__name__)
        self._connected = False
        client.disconnect()
        client.loop_stop()

    # --- callbacks de paho (corren en su hilo) -------------------------------------------------

    def _handle_connect(self, client: Any, userdata: Any, flags: Any, reason_code: Any,
                        properties: Any = None) -> None:
        if getattr(reason_code, "is_failure", False):
            log.warning("MQTT rechazó la conexión (%s)", reason_code)
            return
        self._connected = True
        log.info("Conectado a MQTT")
        client.publish(self._status_topic, payload="online", qos=1, retain=True)
        client.subscribe(self._cmd_topic, qos=1)

    def _handle_disconnect(self, client: Any, userdata: Any, flags: Any, reason_code: Any,
                           properties: Any = None) -> None:
        self._connected = False
        log.info("Desconectado de MQTT (%s); se reintenta cada %d s", reason_code, RECONNECT_S)

    def _handle_message(self, client: Any, userdata: Any, message: Any) -> None:
        if message.topic != self._cmd_topic:
            return
        try:
            body = json.loads(message.payload)
        except ValueError:  # incluye UnicodeDecodeError
            return
        if not isinstance(body, dict) or body.get("type") != "sync":
            return
        revision = body.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int):
            revision = UNKNOWN_REVISION
        try:
            self._on_sync(revision)
        except Exception as exc:  # una falla del aviso no debe tumbar el hilo de MQTT
            log.warning("Falló el manejo de un aviso MQTT (%s)", type(exc).__name__)
