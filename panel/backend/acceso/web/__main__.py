"""Arranque de la web: python -m acceso.web"""
import logging
import sys

import uvicorn

from acceso.config import ConfigError, load_settings
from acceso.migrate import MigrationError, migrate
from acceso.web.app import create_app

log = logging.getLogger("acceso.web")


def main() -> None:
    logging.basicConfig(stream=sys.stdout, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        s = load_settings(required=("ADMIN_USER", "ADMIN_PASSWORD", "SESSION_SECRET"))
        migrate(s.db_path)
    except (ConfigError, MigrationError) as exc:
        log.error("%s", exc)
        sys.exit(1)
    uvicorn.run(create_app(s), host=s.web_host, port=s.web_port)


if __name__ == "__main__":
    main()
