from pathlib import Path

import pytest

from acceso.config import ConfigError, load_settings

BASE = {"UART_PORT": "/dev/ttyS3", "ADMIN_USER": "admin", "ADMIN_PASSWORD": "x", "SESSION_SECRET": "s"}


def test_defaults_applied():
    s = load_settings(BASE)
    assert (s.uart_baud, s.web_host, s.web_port, s.log_max_entries, s.session_hours) == (115200, "0.0.0.0", 8080, 100000, 12)
    assert s.db_path == Path("data/access_control.sqlite") and s.cors_origins == ()


def test_missing_required_lists_all_names():
    with pytest.raises(ConfigError, match="Faltan variables en el .env: UART_PORT, ADMIN_PASSWORD"):
        load_settings({"ADMIN_USER": "admin"}, required=("UART_PORT", "ADMIN_USER", "ADMIN_PASSWORD"))


def test_invalid_integer_names_variable():
    with pytest.raises(ConfigError, match="WEB_PORT debe ser un número entero"):
        load_settings({**BASE, "WEB_PORT": "ochenta"})


def test_cors_origins_split_and_trimmed():
    assert load_settings({**BASE, "CORS_ORIGINS": "http://localhost:3000, http://a"}).cors_origins == ("http://localhost:3000", "http://a")


def test_gsm_port_empty_and_default_baud():
    s = load_settings(BASE)
    assert (s.gsm_port, s.gsm_baud) == ("", 9600)
    s = load_settings({**BASE, "GSM_PORT": " /dev/ttyS1 ", "GSM_BAUD": "19200"})
    assert (s.gsm_port, s.gsm_baud) == ("/dev/ttyS1", 19200)
