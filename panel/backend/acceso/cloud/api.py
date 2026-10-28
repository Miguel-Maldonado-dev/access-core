"""Cliente HTTPS de la API de dispositivos de la nube (/api/device/v1).

Los secretos (panel_secret, device_token, claim_code) no se registran ni aparecen en
los errores: CloudError solo lleva estado, código y el mensaje que devuelve la nube.
"""
import hashlib
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

import httpx

from acceso.cloud.identity import Identity

API_PREFIX = "/api/device/v1"
DEFAULT_TIMEOUT_S = 30.0
_MAX_DETAIL = 200


class CloudError(Exception):
    """Error al hablar con la nube.

    `status` es el HTTP (0 si no hubo respuesta) y `code` el código estable de la nube
    (`unauthorized`, `revoked`, `network_error`, `invalid_response`, `http_error`, ...).
    """

    def __init__(self, status: int, code: str, detail: str = ""):
        self.status = status
        self.code = code
        self.detail = detail
        text = "La nube respondió %s (%s)" % (status, code) if status else "No se pudo hablar con la nube (%s)" % code
        super().__init__(text + (": " + detail if detail else ""))


@dataclass(frozen=True)
class Activation:
    device_token: str = field(repr=False)
    installation_id: str
    installation_name: str


def sha256_hex(text: str) -> str:
    """sha256 hexadecimal minúsculo del texto UTF-8 tal como viaja."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _error_from(response: httpx.Response) -> CloudError:
    code, detail = "http_error", ""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        if isinstance(body.get("code"), str) and body["code"]:
            code = body["code"]
        for key in ("message", "detail"):
            if isinstance(body.get(key), str):
                detail = body[key][:_MAX_DETAIL]
                break
    return CloudError(response.status_code, code, detail)


class CloudApi:
    def __init__(
        self,
        base_url: str,
        transport: Optional[httpx.BaseTransport] = None,
        timeout: float = DEFAULT_TIMEOUT_S,
    ):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/") + API_PREFIX, transport=transport, timeout=timeout
        )
        self._authorization = None  # type: Optional[str]

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "CloudApi":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def authenticate(self, panel_code: str, token: str) -> None:
        """Configura la sesión del dispositivo: `Authorization: Device <panel_code>.<token>`."""
        self._authorization = "Device %s.%s" % (panel_code, token)

    def _send(self, method: str, path: str, *, auth: bool, **kwargs: Any) -> httpx.Response:
        headers = {}  # type: Dict[str, str]
        if auth:
            if self._authorization is None:
                raise RuntimeError("Falta llamar a authenticate() antes de usar la API del dispositivo")
            headers["Authorization"] = self._authorization
        try:
            response = self._client.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            # Solo el tipo de la excepción: su texto podría traer la URL completa.
            raise CloudError(0, "network_error", type(exc).__name__) from None
        if response.status_code >= 400:
            raise _error_from(response)
        return response

    def _json(self, response: httpx.Response) -> Dict[str, Any]:
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise CloudError(response.status_code, "invalid_response", "La respuesta no es un objeto JSON")
        return body

    def _status(self, response: httpx.Response) -> str:
        status = self._json(response).get("status")
        if not isinstance(status, str):
            raise CloudError(response.status_code, "invalid_response", "Falta el campo status")
        return status

    # --- sin autenticación ---

    def register(self, identity: Identity, versions: Mapping[str, Any]) -> str:
        """Registra el panel (solo viajan los hashes). Devuelve el estado que reporta la nube."""
        body = {
            "panel_code": identity.panel_code,
            "claim_code_hash": sha256_hex(identity.claim_code),
            "panel_secret_hash": sha256_hex(identity.panel_secret),
            "software_version": versions["software_version"],
            "schema_version": versions["schema_version"],
        }
        return self._status(self._send("POST", "/register", auth=False, json=body))

    def activate(self, panel_code: str, panel_secret: str) -> Optional[Activation]:
        """None si la nube responde 202 (aún sin reclamar); la credencial si responde 200."""
        response = self._send(
            "POST", "/activate", auth=False, json={"panel_code": panel_code, "panel_secret": panel_secret}
        )
        if response.status_code == 202:
            return None
        body = self._json(response)
        try:
            token, installation_id, name = body["device_token"], body["installation_id"], body["installation_name"]
        except KeyError:
            raise CloudError(response.status_code, "invalid_response", "Faltan campos en la activación") from None
        if not all(isinstance(v, str) and v for v in (token, installation_id, name)):
            raise CloudError(response.status_code, "invalid_response", "Campos de activación inválidos")
        return Activation(token, installation_id, name)

    # --- con la credencial del dispositivo ---

    def link_state(self) -> str:
        return self._status(self._send("GET", "/link-state", auth=True))

    def import_snapshot(self, tables: Mapping[str, List[Any]]) -> str:
        return self._status(self._send("POST", "/import-snapshot", auth=True, json={"tables": tables}))

    def get_changes(self, since: int, limit: int = 500) -> Dict[str, Any]:
        return self._json(self._send("GET", "/changes", auth=True, params={"since": since, "limit": limit}))

    def post_changes(self, items: List[Any]) -> Dict[str, Any]:
        return self._json(self._send("POST", "/changes", auth=True, json={"changes": items}))

    def post_logs(self, logs: List[Any]) -> Dict[str, Any]:
        return self._json(self._send("POST", "/logs", auth=True, json={"logs": logs}))

    def get_checksums(self) -> Dict[str, Any]:
        return self._json(self._send("GET", "/checksums", auth=True))

    def get_snapshot(self, table: str) -> Dict[str, Any]:
        return self._json(self._send("GET", "/snapshot", auth=True, params={"table": table}))

    def post_alert(self, alert: Mapping[str, Any]) -> None:
        self._send("POST", "/alerts", auth=True, json=dict(alert))
