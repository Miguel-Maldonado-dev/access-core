"""Arranque de la web: python -m acceso.web"""
import uvicorn

from acceso.config import load_settings
from acceso.migrate import migrate
from acceso.web.app import create_app


def main() -> None:
    s = load_settings(required=("ADMIN_USER", "ADMIN_PASSWORD", "SESSION_SECRET"))
    migrate(s.db_path)
    uvicorn.run(create_app(s), host=s.web_host, port=s.web_port)


if __name__ == "__main__":
    main()
