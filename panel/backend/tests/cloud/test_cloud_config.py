import os
import stat
from pathlib import Path

import pytest

from acceso.cloud.config import (
    DEFAULT_CREDENTIALS_PATH,
    clear_credentials,
    load_cloud_settings,
    load_credentials,
    save_credentials,
)
from acceso.config import ConfigError

CODE = "PNL-0123-4ABC"
TOKEN = "A" * 43


def test_defaults():
    s = load_cloud_settings({})
    assert s.cloud_url == "" and s.mqtt_url == ""
    assert s.credentials_path == Path(DEFAULT_CREDENTIALS_PATH) == Path("/etc/acceso/cloud.env")


def test_reads_variables_and_trims_trailing_slash():
    s = load_cloud_settings(
        {
            "CLOUD_URL": " https://nube.example.com/ ",
            "MQTT_URL": "mqtts://mqtt.example.com:8883",
            "CLOUD_CREDENTIALS_PATH": "/tmp/x.env",
        }
    )
    assert s.cloud_url == "https://nube.example.com"
    assert s.mqtt_url == "mqtts://mqtt.example.com:8883"
    assert s.credentials_path == Path("/tmp/x.env")


def test_invalid_cloud_url_is_rejected_in_spanish():
    with pytest.raises(ConfigError, match="CLOUD_URL debe empezar con http:// o https://"):
        load_cloud_settings({"CLOUD_URL": "nube.example.com"})


def test_required_lists_missing_names():
    with pytest.raises(ConfigError, match="Faltan variables en el .env: CLOUD_URL, MQTT_URL"):
        load_cloud_settings({}, required=("CLOUD_URL", "MQTT_URL"))


def test_reads_urls_from_credentials_file(tmp_path, monkeypatch):
    creds = tmp_path / "cloud.env"
    creds.write_text("CLOUD_URL=https://desde-archivo.example.com\nMQTT_URL=mqtt://m:1883\n")
    for name in ("CLOUD_URL", "MQTT_URL", "CLOUD_CREDENTIALS_PATH"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CLOUD_CREDENTIALS_PATH", str(creds))
    monkeypatch.setenv("ACCESO_ENV_FILE", str(tmp_path / "no-existe.env"))
    s = load_cloud_settings()
    assert s.cloud_url == "https://desde-archivo.example.com"
    assert s.mqtt_url == "mqtt://m:1883"


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def test_save_credentials_keeps_other_lines_and_sets_mode_0600(tmp_path):
    path = tmp_path / "cloud.env"
    path.write_text("# nube\nCLOUD_URL=https://x.example.com\nMQTT_URL=mqtt://m\n")
    os.chmod(path, 0o644)
    save_credentials(path, CODE, TOKEN)
    lines = path.read_text().splitlines()
    assert lines[:3] == ["# nube", "CLOUD_URL=https://x.example.com", "MQTT_URL=mqtt://m"]
    assert "CLOUD_PANEL_CODE=" + CODE in lines and "CLOUD_DEVICE_TOKEN=" + TOKEN in lines
    assert mode(path) == 0o600
    assert load_credentials(path) == (CODE, TOKEN)


def test_save_credentials_replaces_previous_values_without_duplicates(tmp_path):
    path = tmp_path / "cloud.env"
    save_credentials(path, CODE, TOKEN)
    save_credentials(path, "PNL-ZZZZ-9999", "B" * 43)
    text = path.read_text()
    assert text.count("CLOUD_PANEL_CODE=") == 1 and text.count("CLOUD_DEVICE_TOKEN=") == 1
    assert load_credentials(path) == ("PNL-ZZZZ-9999", "B" * 43)


def test_save_credentials_rewrites_same_file_in_place(tmp_path):
    path = tmp_path / "cloud.env"
    path.write_text("CLOUD_URL=https://x.example.com\n")
    inode = os.stat(path).st_ino
    save_credentials(path, CODE, TOKEN)
    assert os.stat(path).st_ino == inode


def test_save_credentials_works_when_directory_is_read_only(tmp_path):
    directory = tmp_path / "etc"
    directory.mkdir()
    path = directory / "cloud.env"
    path.write_text("CLOUD_URL=https://x.example.com\n")
    os.chmod(directory, 0o500)
    try:
        save_credentials(path, CODE, TOKEN)
    finally:
        os.chmod(directory, 0o700)
    assert load_credentials(path) == (CODE, TOKEN)


def test_save_credentials_creates_missing_file_with_mode_0600(tmp_path):
    path = tmp_path / "nuevo.env"
    save_credentials(path, CODE, TOKEN)
    assert mode(path) == 0o600 and load_credentials(path) == (CODE, TOKEN)


@pytest.mark.parametrize(
    "code,token",
    [("PNL-0123-4ABC\nX=1", TOKEN), (CODE, "tok en"), (CODE, "tok\nCLOUD_URL=x"), ("malo", TOKEN), (CODE, "")],
)
def test_save_credentials_rejects_values_that_could_inject_lines(tmp_path, code, token):
    path = tmp_path / "cloud.env"
    with pytest.raises(ValueError) as exc:
        save_credentials(path, code, token)
    assert token not in str(exc.value) or token == ""
    assert not path.exists()


def test_load_credentials_none_when_missing_or_incomplete(tmp_path):
    assert load_credentials(tmp_path / "no-existe.env") is None
    path = tmp_path / "cloud.env"
    path.write_text("CLOUD_PANEL_CODE=%s\n" % CODE)
    assert load_credentials(path) is None


def test_clear_credentials_removes_only_credentials(tmp_path):
    path = tmp_path / "cloud.env"
    path.write_text("CLOUD_URL=https://x.example.com\n")
    save_credentials(path, CODE, TOKEN)
    clear_credentials(path)
    assert load_credentials(path) is None
    assert path.read_text() == "CLOUD_URL=https://x.example.com\n"
    assert mode(path) == 0o600


def test_clear_credentials_on_missing_file_is_noop(tmp_path):
    clear_credentials(tmp_path / "no-existe.env")
    assert not (tmp_path / "no-existe.env").exists()


def test_save_credentials_fails_clearly_when_directory_is_missing(tmp_path):
    path = tmp_path / "no-existe" / "cloud.env"
    with pytest.raises(ConfigError, match="No se pudieron guardar las credenciales") as exc:
        save_credentials(path, CODE, TOKEN)
    assert TOKEN not in str(exc.value)
    assert not path.parent.exists()


def test_save_credentials_fails_clearly_when_file_is_not_writable(tmp_path):
    path = tmp_path / "cloud.env"
    path.write_text("CLOUD_URL=https://x.example.com\n")
    os.chmod(path, 0o400)
    try:
        with pytest.raises(ConfigError, match="No se pudieron guardar las credenciales") as exc:
            save_credentials(path, CODE, TOKEN)
    finally:
        os.chmod(path, 0o600)
    assert TOKEN not in str(exc.value)
    assert path.read_text() == "CLOUD_URL=https://x.example.com\n"
