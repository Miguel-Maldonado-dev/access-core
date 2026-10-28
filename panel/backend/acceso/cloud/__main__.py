"""Arranque del agente de nube: python -m acceso.cloud"""
import logging
import signal
import sys
import threading
import time

from acceso.cloud.api import CloudApi
from acceso.cloud.config import load_cloud_settings
from acceso.cloud.mqtt_link import MqttLink
from acceso.cloud.runner import Runner
from acceso.cloud.sync import SyncEngine
from acceso.config import ConfigError, load_settings
from acceso.migrate import MigrationError, migrate

log = logging.getLogger("acceso.cloud")


def main() -> None:
    logging.basicConfig(stream=sys.stdout, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = load_settings()
        cloud = load_cloud_settings()
        migrate(settings.db_path)
    except (ConfigError, MigrationError) as exc:
        log.error("%s", exc)
        sys.exit(1)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    api = CloudApi(cloud.cloud_url)
    runner = Runner(cloud, settings.db_path, api,
                    engine_factory=lambda db_path, cloud_api: SyncEngine(db_path, cloud_api),
                    mqtt_factory=MqttLink, clock=time.monotonic, sleep=stop.wait)
    log.info("Agente de nube iniciado")
    try:
        runner.run(stop)
    finally:
        api.close()
    log.info("Agente de nube detenido")


if __name__ == "__main__":
    main()
