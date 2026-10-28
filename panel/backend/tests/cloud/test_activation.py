import hashlib
import json

import httpx
import pytest

from acceso.cloud.api import Activation, CloudApi, CloudError
from acceso.cloud.identity import Identity

BASE = "https://nube.example.com"
IDENTITY = Identity("PNL-0123-4ABC", "K7M2Q9XB", "ab" * 32)
TOKEN = "T" * 43


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def make_api(handler, base=BASE):
    seen = []

    def wrapper(request):
        seen.append(request)
        return handler(request)

    return CloudApi(base, transport=httpx.MockTransport(wrapper)), seen


def json_response(status, body):
    return httpx.Response(status, json=body)


def test_register_sends_hashes_and_never_the_clear_secrets():
    api, seen = make_api(lambda r: json_response(201, {"status": "pending"}))
    status = api.register(IDENTITY, {"software_version": "0.1.0", "schema_version": 6})
    assert status == "pending"
    request = seen[0]
    assert (request.method, request.url.path) == ("POST", "/api/device/v1/register")
    body = json.loads(request.content)
    assert body == {
        "panel_code": "PNL-0123-4ABC",
        "claim_code_hash": sha("K7M2Q9XB"),
        "panel_secret_hash": sha("ab" * 32),
        "software_version": "0.1.0",
        "schema_version": 6,
    }
    assert b"K7M2Q9XB" not in request.content and ("ab" * 32).encode() not in request.content
    assert "authorization" not in request.headers


def test_register_returns_status_of_existing_panel():
    api, _ = make_api(lambda r: json_response(200, {"status": "active"}))
    assert api.register(IDENTITY, {"software_version": "x", "schema_version": 6}) == "active"


def test_register_conflict_raises_cloud_error():
    api, _ = make_api(lambda r: json_response(409, {"code": "panel_code_taken", "message": "otro secreto"}))
    with pytest.raises(CloudError) as exc:
        api.register(IDENTITY, {"software_version": "x", "schema_version": 6})
    assert (exc.value.status, exc.value.code) == (409, "panel_code_taken")


def test_base_url_with_trailing_slash_is_accepted():
    api, seen = make_api(lambda r: json_response(201, {"status": "pending"}), base=BASE + "/")
    api.register(IDENTITY, {"software_version": "x", "schema_version": 6})
    assert str(seen[0].url) == BASE + "/api/device/v1/register"


def test_activate_202_returns_none_and_sends_the_secret():
    api, seen = make_api(lambda r: json_response(202, {"status": "pending"}))
    assert api.activate("PNL-0123-4ABC", "ab" * 32) is None
    assert seen[0].url.path == "/api/device/v1/activate"
    assert json.loads(seen[0].content) == {"panel_code": "PNL-0123-4ABC", "panel_secret": "ab" * 32}


def test_activate_200_returns_activation():
    payload = {"device_token": TOKEN, "installation_id": "11111111-1111-1111-1111-111111111111", "installation_name": "Residencial Sur"}
    api, _ = make_api(lambda r: json_response(200, payload))
    activation = api.activate("PNL-0123-4ABC", "ab" * 32)
    assert activation == Activation(TOKEN, "11111111-1111-1111-1111-111111111111", "Residencial Sur")


def test_activation_repr_hides_the_token():
    activation = Activation(TOKEN, "i", "n")
    assert TOKEN not in repr(activation)


def test_activate_then_save_credentials_leaves_mode_0600(tmp_path):
    import os
    import stat

    from acceso.cloud.config import load_credentials, save_credentials

    payload = {"device_token": TOKEN, "installation_id": "i", "installation_name": "n"}
    api, _ = make_api(lambda r: json_response(200, payload))
    activation = api.activate("PNL-0123-4ABC", "ab" * 32)
    path = tmp_path / "cloud.env"
    save_credentials(path, "PNL-0123-4ABC", activation.device_token)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert load_credentials(path) == ("PNL-0123-4ABC", TOKEN)


def test_activate_200_with_missing_fields_is_invalid_response():
    api, _ = make_api(lambda r: json_response(200, {"device_token": TOKEN}))
    with pytest.raises(CloudError) as exc:
        api.activate("PNL-0123-4ABC", "ab" * 32)
    assert exc.value.code == "invalid_response"


@pytest.mark.parametrize("status,code", [(410, "revoked"), (409, "already_activated"), (401, "unauthorized")])
def test_activate_errors_map_to_cloud_error_without_leaking_the_secret(status, code):
    api, _ = make_api(lambda r: json_response(status, {"code": code, "message": "texto de la nube"}))
    with pytest.raises(CloudError) as exc:
        api.activate("PNL-0123-4ABC", "ab" * 32)
    assert (exc.value.status, exc.value.code) == (status, code)
    assert ("ab" * 32) not in str(exc.value) and ("ab" * 32) not in repr(exc.value)


def test_get_changes_401_raises_unauthorized():
    api, _ = make_api(lambda r: json_response(401, {"code": "unauthorized", "message": "Credencial de dispositivo inválida."}))
    api.authenticate("PNL-0123-4ABC", TOKEN)
    with pytest.raises(CloudError) as exc:
        api.get_changes(0, 500)
    assert exc.value.status == 401 and exc.value.code == "unauthorized"


def test_authenticated_requests_carry_the_device_header_and_query():
    body = {"revision": 7, "has_more": False, "confirm_deletions": False, "changes": []}
    api, seen = make_api(lambda r: json_response(200, body))
    api.authenticate("PNL-0123-4ABC", TOKEN)
    assert api.get_changes(5, 200) == body
    request = seen[0]
    assert request.method == "GET" and request.url.path == "/api/device/v1/changes"
    assert dict(request.url.params) == {"since": "5", "limit": "200"}
    assert request.headers["authorization"] == "Device PNL-0123-4ABC." + TOKEN


def test_link_state_returns_status():
    api, seen = make_api(lambda r: json_response(200, {"status": "awaiting_review"}))
    api.authenticate("PNL-0123-4ABC", TOKEN)
    assert api.link_state() == "awaiting_review"
    assert seen[0].url.path == "/api/device/v1/link-state"


def test_import_snapshot_sends_tables_and_returns_status():
    api, seen = make_api(lambda r: json_response(202, {"status": "active"}))
    api.authenticate("PNL-0123-4ABC", TOKEN)
    tables = {"holders": [{"id": "a", "data": {"name": "x"}}], "cards": []}
    assert api.import_snapshot(tables) == "active"
    assert json.loads(seen[0].content) == {"tables": tables}
    assert seen[0].url.path == "/api/device/v1/import-snapshot"


def test_post_changes_post_logs_and_post_alert_bodies():
    def handler(request):
        if request.url.path.endswith("/alerts"):
            return httpx.Response(204)
        if request.url.path.endswith("/logs"):
            return json_response(200, {"accepted": 1, "last_local_log_id": 9})
        return json_response(200, {"revision": 3, "results": []})

    api, seen = make_api(handler)
    api.authenticate("PNL-0123-4ABC", TOKEN)
    items = [{"change_id": "c" * 32, "table": "holders", "op": "delete", "id": "u", "updated_at": "2026-01-01T00:00:00.000Z"}]
    assert api.post_changes(items) == {"revision": 3, "results": []}
    assert api.post_logs([{"local_log_id": 9}]) == {"accepted": 1, "last_local_log_id": 9}
    alert = {"type": "mass_delete_blocked", "table": "cards", "would_delete": 30, "total": 100}
    assert api.post_alert(alert) is None
    assert [json.loads(r.content) for r in seen] == [{"changes": items}, {"logs": [{"local_log_id": 9}]}, alert]


def test_get_checksums_and_get_snapshot():
    def handler(request):
        if request.url.path.endswith("/checksums"):
            return json_response(200, {"revision": 1, "confirm_deletions": False, "tables": {"holders": "0" * 64}})
        return json_response(200, {"revision": 1, "rows": []})

    api, seen = make_api(handler)
    api.authenticate("PNL-0123-4ABC", TOKEN)
    assert api.get_checksums()["tables"]["holders"] == "0" * 64
    assert api.get_snapshot("cards") == {"revision": 1, "rows": []}
    assert dict(seen[1].url.params) == {"table": "cards"}


def test_authenticated_call_without_authenticate_is_a_programming_error():
    api, seen = make_api(lambda r: json_response(200, {}))
    with pytest.raises(RuntimeError, match="authenticate"):
        api.link_state()
    assert seen == []


def test_non_json_error_body_gives_generic_code():
    api, _ = make_api(lambda r: httpx.Response(502, text="<html>Bad gateway</html>"))
    api.authenticate("PNL-0123-4ABC", TOKEN)
    with pytest.raises(CloudError) as exc:
        api.link_state()
    assert (exc.value.status, exc.value.code) == (502, "http_error")


def test_error_body_with_detail_key_is_used_as_message():
    api, _ = make_api(lambda r: json_response(409, {"detail": "El panel todavía no está activo", "code": "not_active"}))
    api.authenticate("PNL-0123-4ABC", TOKEN)
    with pytest.raises(CloudError) as exc:
        api.get_snapshot("holders")
    assert exc.value.code == "not_active" and "no está activo" in str(exc.value)


def test_network_failure_becomes_cloud_error():
    def handler(request):
        raise httpx.ConnectError("sin red", request=request)

    api, _ = make_api(handler)
    api.authenticate("PNL-0123-4ABC", TOKEN)
    with pytest.raises(CloudError) as exc:
        api.link_state()
    assert (exc.value.status, exc.value.code) == (0, "network_error")


def test_success_with_invalid_json_is_invalid_response():
    api, _ = make_api(lambda r: httpx.Response(200, text="no es json"))
    api.authenticate("PNL-0123-4ABC", TOKEN)
    with pytest.raises(CloudError) as exc:
        api.link_state()
    assert exc.value.code == "invalid_response"


def test_token_is_never_in_cloud_error_text():
    api, _ = make_api(lambda r: json_response(401, {"code": "unauthorized", "message": "Credencial inválida"}))
    api.authenticate("PNL-0123-4ABC", TOKEN)
    with pytest.raises(CloudError) as exc:
        api.link_state()
    assert TOKEN not in str(exc.value) and TOKEN not in repr(exc.value)
