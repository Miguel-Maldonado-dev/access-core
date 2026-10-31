"""Nube falsa para las pruebas del motor de sincronización.

Sigue el contrato real de `/api/device/v1` (cloud/src/lib/device/{contract,changes,apply,logs}.ts):
- GET /changes?since&limit: filas con since < revision <= R, por revisión; `revision` = R si no
  hay más, o la del último cambio devuelto si `has_more`.
- POST /changes: valida cada cambio como `pushItemSchema` (data estricta por tabla) y responde
  `{revision, results}`; un resultado que no es `applied` lleva `current` (`{data}` o null).
- POST /logs valida como `logItemSchema` (una lista vacía solo marca la hora de la subida);
  GET /checksums, GET /snapshot, POST /alerts (204) y POST /command-result (204).
Guarda revisiones como `installations.revision`: cada escritura sube la revisión.
"""
import json
import re
from datetime import datetime

import httpx

from acceso.cloud.api import CloudApi
from acceso.cloud.checksum import table_checksum

BASE = "https://nube.example.com"
PREFIX = "/api/device/v1"
TABLES = ("holders", "cards", "controls", "control_buttons", "permissions",
          "holder_permissions", "outputs")

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ISO_MS_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def _int(lo, hi):
    return lambda v: isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _text(v):
    return isinstance(v, str) and "\u0000" not in v


def _nullable(check):
    return lambda v: v is None or check(v)


_uuid = lambda v: isinstance(v, str) and bool(_UUID.match(v))  # noqa: E731
_bool = lambda v: isinstance(v, bool)  # noqa: E731
_mask = _int(0, 15)
_code = _int(0, 4294967295)
_minute = _int(0, 1439)

# Igual que dataSchemas de contract.ts (estrictos: ni una clave de más ni de menos).
DATA_SCHEMAS = {
    "holders": {
        "kind": lambda v: v in ("persona", "domicilio"),
        "name": lambda v: _text(v) and bool(re.search(r"[^ ]", v)),
        "department": _text, "address": _text, "notes": _text,
        "pin": _nullable(lambda v: _text(v) and bool(re.match(r"^[0-9]{4,6}$", v))),
    },
    "cards": {"card_code": _code, "holder_id": _uuid, "description": _text},
    "controls": {"holder_id": _uuid, "description": _text},
    "control_buttons": {"control_id": _uuid, "button": _int(0, 3), "rf_code": _code,
                        "output_id": _nullable(_int(0, 3))},
    "permissions": {"permission_id": _int(0, 31), "name": _text, "output_mask": _mask,
                    "card_reader_mask": _mask, "pin_reader_mask": _mask, "allow_rf": _bool,
                    "weekday_mask": _int(0, 127), "start_minute": _minute, "end_minute": _minute},
    "holder_permissions": {"holder_id": _uuid, "permission_id": _int(0, 31)},
    "outputs": {"output_id": _int(0, 3), "alias": _text, "duration_ms": _int(0, 65535),
                "reader_mask": _mask, "enabled": _bool},
}

LOG_SCHEMA = {
    "local_log_id": _int(1, 2 ** 53 - 1),
    "timestamp": lambda v: isinstance(v, str) and bool(_ISO_MS_Z.match(v)),
    "allowed": _bool,
    "source": _int(0, 255),
    "reason": _int(0, 255),
    "holder_id": _nullable(_uuid),
    "holder_name": _nullable(lambda v: _text(v) and len(v) <= 1000),
    "holder_kind": _nullable(lambda v: v in ("persona", "domicilio")),
    "credential_label": _nullable(lambda v: _text(v) and len(v) <= 1000),
    "control_id": _nullable(_uuid),
    "code": _nullable(_code),
    "device_id": _nullable(_int(0, 255)),
    "output_id": _nullable(_int(0, 3)),
}


class ContractViolation(AssertionError):
    pass


def check_data(table, data):
    schema = DATA_SCHEMAS[table]
    if not isinstance(data, dict) or set(data) != set(schema):
        raise ContractViolation("data de %s con claves %s" % (table, sorted(data or {})))
    for key, check in schema.items():
        if not check(data[key]):
            raise ContractViolation("valor inválido en %s.%s: %r" % (table, key, data[key]))


def check_push_item(item):
    allowed = {"change_id", "table", "op", "id", "updated_at", "data"}
    if set(item) - allowed:
        raise ContractViolation("claves de más en el cambio: %s" % sorted(set(item) - allowed))
    if not (isinstance(item.get("change_id"), str) and 1 <= len(item["change_id"]) <= 64):
        raise ContractViolation("change_id inválido")
    if item.get("table") not in TABLES or item.get("op") not in ("upsert", "delete"):
        raise ContractViolation("tabla u op inválida")
    if not _uuid(item.get("id")):
        raise ContractViolation("id no es UUID")
    if not (isinstance(item.get("updated_at"), str) and _ISO_MS_Z.match(item["updated_at"])):
        raise ContractViolation("updated_at no es ISO-8601 UTC con ms: %r" % item.get("updated_at"))
    datetime.strptime(item["updated_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
    if item["op"] == "upsert":
        check_data(item["table"], item.get("data"))


def check_log(log):
    if set(log) != set(LOG_SCHEMA):
        raise ContractViolation("log con claves %s" % sorted(log))
    for key, check in LOG_SCHEMA.items():
        if not check(log[key]):
            raise ContractViolation("valor inválido en log.%s: %r" % (key, log[key]))


class FakeCloud:
    def __init__(self):
        self.revision = 0
        # tabla -> id -> {"data", "revision", "deleted"}
        self.rows = {t: {} for t in TABLES}
        self.confirm_deletions = False
        self.forced = {}        # id -> (status, reason): resultado forzado del push
        self.fail = None        # callable(request) -> httpx.Response | None
        self.requests = []      # (method, path, params, body)
        self.pushed = []        # cada lote de POST /changes
        self.logs = []
        self.logs_uploads = 0
        self.alerts = []
        self.command_results = []
        self.after_checksums = None  # callable() que corre después de responder /checksums

    # --- estado de la nube ------------------------------------------------------------------
    def put(self, table, row_id, data):
        check_data(table, data)
        self.revision += 1
        self.rows[table][row_id] = {"data": dict(data), "revision": self.revision, "deleted": False}
        return self.revision

    def remove(self, table, row_id):
        self.revision += 1
        row = self.rows[table].setdefault(row_id, {"data": None})
        row.update(revision=self.revision, deleted=True)
        return self.revision

    def seed(self, tables):
        """Copia un snapshot del panel a la nube (como una importación)."""
        for table in TABLES:
            for row in tables[table]:
                self.put(table, row["id"], row["data"])

    def live(self, table):
        return [{"id": i, "data": r["data"]} for i, r in sorted(self.rows[table].items())
                if not r["deleted"]]

    def live_row(self, table, row_id):
        row = self.rows[table].get(row_id)
        return None if row is None or row["deleted"] else row["data"]

    def api(self):
        api = CloudApi(BASE, transport=httpx.MockTransport(self.handle))
        api.authenticate("PNL-0123-4ABC", "T" * 43)
        return api

    def paths(self, method=None):
        return [p for m, p, _, _ in self.requests if method is None or m == method]

    # --- HTTP ---------------------------------------------------------------------------------
    def handle(self, request):
        path = request.url.path[len(PREFIX):]
        params = dict(request.url.params)
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, path, params, body))
        assert request.headers["authorization"].startswith("Device PNL-")
        if self.fail is not None:
            response = self.fail(request)
            if response is not None:
                return response
        route = (request.method, path)
        if route == ("GET", "/changes"):
            return httpx.Response(200, json=self._changes(int(params["since"]), int(params.get("limit", 500))))
        if route == ("POST", "/changes"):
            return httpx.Response(200, json=self._push(body["changes"]))
        if route == ("POST", "/logs"):
            return httpx.Response(200, json=self._logs(body["logs"]))
        if route == ("GET", "/checksums"):
            response = httpx.Response(200, json={
                "revision": self.revision, "confirm_deletions": self.confirm_deletions,
                "tables": {t: table_checksum(self.live(t)) for t in TABLES}})
            if self.after_checksums is not None:
                self.after_checksums()
            return response
        if route == ("GET", "/snapshot"):
            return httpx.Response(200, json={"revision": self.revision, "rows": self.live(params["table"])})
        if route == ("POST", "/alerts"):
            assert set(body) == {"type", "table", "would_delete", "total"}
            assert body["type"] == "mass_delete_blocked" and body["table"] in ("holders", "cards")
            self.alerts.append(body)
            return httpx.Response(204)
        if route == ("POST", "/command-result"):
            assert set(body) == {"command_id", "ok", "detail"}
            assert _uuid(body["command_id"]) and isinstance(body["ok"], bool)
            assert body["detail"] is None or isinstance(body["detail"], str)
            self.command_results.append(body)
            return httpx.Response(204)
        return httpx.Response(404, json={"code": "not_found", "message": "Ruta desconocida"})

    def _changes(self, since, limit):
        assert 1 <= limit <= 500
        R = self.revision
        if since >= R:
            return {"revision": R, "has_more": False, "confirm_deletions": self.confirm_deletions,
                    "changes": []}
        crudas = sorted(
            ((r["revision"], t, i, r) for t in TABLES for i, r in self.rows[t].items()
             if since < r["revision"] <= R),
            key=lambda x: x[0])
        has_more = len(crudas) > limit
        pagina = crudas[:limit]
        changes = []
        for revision, table, row_id, row in pagina:
            if row["deleted"]:
                changes.append({"table": table, "op": "delete", "id": row_id, "revision": revision})
            else:
                changes.append({"table": table, "op": "upsert", "id": row_id, "revision": revision,
                                "data": row["data"]})
        return {"revision": pagina[-1][0] if has_more else R, "has_more": has_more,
                "confirm_deletions": self.confirm_deletions, "changes": changes}

    def _push(self, items):
        assert len(items) <= 500
        for item in items:
            check_push_item(item)
        self.pushed.append(items)
        results = []
        for item in items:
            table, row_id = item["table"], item["id"]
            forced = self.forced.get(row_id)
            if forced is not None:
                status, reason = forced
                result = {"change_id": item["change_id"], "status": status}
                if reason:
                    result["reason"] = reason
            elif item["op"] == "delete":
                if self.live_row(table, row_id) is not None:
                    self.remove(table, row_id)
                result = {"change_id": item["change_id"], "status": "applied", "revision": self.revision}
            else:
                self.put(table, row_id, item["data"])
                result = {"change_id": item["change_id"], "status": "applied", "revision": self.revision}
            if result["status"] != "applied":
                data = self.live_row(table, row_id)
                result["current"] = None if data is None else {"data": data}
            results.append(result)
        return {"revision": self.revision, "results": results}

    def _logs(self, logs):
        assert len(logs) <= 500
        for log in logs:
            check_log(log)
        self.logs.extend(logs)
        self.logs_uploads += 1   # cada POST /logs, aunque venga vacío, actualiza logs_uploaded_at
        last = max((l["local_log_id"] for l in logs), default=None)
        return {"accepted": len(logs), "last_local_log_id": last}
