import re

from acceso.cloud.identity import Identity, ensure_identity, get_state, regenerate_claim_code, set_state

PANEL_CODE_RE = re.compile(r"^PNL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$")
CLAIM_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{8}$")
SECRET_RE = re.compile(r"^[0-9a-f]{64}$")


def test_ensure_identity_generates_expected_formats(conn):
    identity = ensure_identity(conn)
    assert PANEL_CODE_RE.match(identity.panel_code)
    assert CLAIM_RE.match(identity.claim_code)
    assert SECRET_RE.match(identity.panel_secret)


def test_ensure_identity_is_stable_on_second_call(conn):
    first = ensure_identity(conn)
    assert ensure_identity(conn) == first


def test_ensure_identity_persists_in_sync_state(conn):
    identity = ensure_identity(conn)
    assert get_state(conn, "panel_code") == identity.panel_code
    assert get_state(conn, "claim_code") == identity.claim_code
    assert get_state(conn, "panel_secret") == identity.panel_secret
    assert get_state(conn, "state") == "unlinked"


def test_ensure_identity_does_not_reset_existing_state(conn):
    set_state(conn, "state", "active")
    ensure_identity(conn)
    assert get_state(conn, "state") == "active"


def test_ensure_identity_differs_between_panels(tmp_path):
    from acceso.db import connect
    from acceso.schema import create_schema

    a, b = connect(tmp_path / "a.sqlite"), connect(tmp_path / "b.sqlite")
    try:
        create_schema(a)
        create_schema(b)
        ia, ib = ensure_identity(a), ensure_identity(b)
        assert ia.panel_secret != ib.panel_secret and ia.panel_code != ib.panel_code
    finally:
        a.close()
        b.close()


def test_regenerate_claim_code_changes_only_the_claim_code(conn):
    before = ensure_identity(conn)
    new_code = regenerate_claim_code(conn)
    after = ensure_identity(conn)
    assert CLAIM_RE.match(new_code)
    assert after.claim_code == new_code
    assert (after.panel_code, after.panel_secret) == (before.panel_code, before.panel_secret)


def test_regenerate_claim_code_without_identity_creates_it(conn):
    new_code = regenerate_claim_code(conn)
    identity = ensure_identity(conn)
    assert identity.claim_code == new_code and PANEL_CODE_RE.match(identity.panel_code)


def test_identity_repr_hides_secrets():
    identity = Identity("PNL-AAAA-BBBB", "ABCD2345", "f" * 64)
    text = repr(identity)
    assert "ABCD2345" not in text and "f" * 64 not in text
    assert "PNL-AAAA-BBBB" in text


def test_get_state_default_and_overwrite(conn):
    assert get_state(conn, "last_error") is None
    assert get_state(conn, "last_error", "") == ""
    set_state(conn, "last_error", "uno")
    set_state(conn, "last_error", "dos")
    assert get_state(conn, "last_error") == "dos"
