import json

from acceso.cloud.identity import ensure_identity, set_state
from helpers import add_holder


def _link(db, state="active"):
    ident = ensure_identity(db)
    set_state(db, "state", state)
    set_state(db, "installation_id", "inst-1")
    set_state(db, "installation_name", "Fraccionamiento Los Pinos")
    set_state(db, "cloud_revision", "42")
    set_state(db, "last_sync_at", "2026-10-28T08:00:00.000Z")
    db.commit()
    return ident


def test_requires_session(anon_client):
    assert anon_client.get("/api/cloud/status").status_code == 401


def test_without_identity_has_no_panel_code(client, db):
    r = client.get("/api/cloud/status")
    assert r.status_code == 200
    assert r.json() == {
        "panel_code": None, "claim_code": None, "state": "unlinked", "installation_name": None,
        "last_sync_at": None, "cloud_revision": 0, "pending_changes": 0, "last_error": None,
    }


def test_unlinked_shows_codes(client, db):
    ident = ensure_identity(db)
    body = client.get("/api/cloud/status").json()
    assert body["panel_code"] == ident.panel_code
    assert body["claim_code"] == ident.claim_code
    assert body["state"] == "unlinked"
    assert body["installation_name"] is None and body["last_sync_at"] is None
    assert body["cloud_revision"] == 0 and body["last_error"] is None


def test_linked_hides_claim_code(client, db):
    ident = _link(db)
    body = client.get("/api/cloud/status").json()
    assert body["panel_code"] == ident.panel_code
    assert body["claim_code"] is None
    assert body["state"] == "active"
    assert body["installation_name"] == "Fraccionamiento Los Pinos"
    assert body["last_sync_at"] == "2026-10-28T08:00:00.000Z"
    assert body["cloud_revision"] == 42


def test_staging_hides_claim_code(client, db):
    _link(db, "staging")
    assert client.get("/api/cloud/status").json()["claim_code"] is None


def test_never_exposes_secrets(client, db, tmp_path, monkeypatch):
    ident = _link(db)
    token = "tok-super-secreto-123"
    creds = tmp_path / "cloud.env"
    creds.write_text("CLOUD_DEVICE_TOKEN=%s\n" % token)
    monkeypatch.setenv("CLOUD_CREDENTIALS_PATH", str(creds))
    monkeypatch.setenv("CLOUD_DEVICE_TOKEN", token)
    r = client.get("/api/cloud/status")
    assert "panel_secret" not in r.json()
    assert ident.panel_secret not in r.text
    assert token not in r.text
    assert set(r.json()) == {"panel_code", "claim_code", "state", "installation_name",
                             "last_sync_at", "cloud_revision", "pending_changes", "last_error"}


def test_pending_changes_counts_outbox(client, db):
    ensure_identity(db)
    assert client.get("/api/cloud/status").json()["pending_changes"] == 0
    add_holder(db, "Ana", "persona")
    db.commit()
    n = db.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()[0]
    assert n > 0
    assert client.get("/api/cloud/status").json()["pending_changes"] == n


def test_last_error_empty_is_null(client, db):
    _link(db)
    set_state(db, "last_error", "")
    db.commit()
    assert client.get("/api/cloud/status").json()["last_error"] is None


def test_last_error_text(client, db):
    _link(db)
    set_state(db, "last_error", "No se pudo contactar la plataforma.")
    db.commit()
    assert client.get("/api/cloud/status").json()["last_error"] == "No se pudo contactar la plataforma."


def test_response_is_json_serializable_and_get_only(client, db):
    json.dumps(client.get("/api/cloud/status").json())
    assert client.post("/api/cloud/status").status_code in (404, 405)
