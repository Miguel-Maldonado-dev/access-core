"""Checksum de una tabla replicada, idéntico al de la nube (cloud/src/lib/device/checksum.ts).

sha256 hexadecimal de la concatenación de una línea por registro, ordenada por `id`:
`id + "\\t" + json_canónico(data) + "\\n"`. El JSON canónico tiene las claves ordenadas, sin
espacios, UTF-8 sin escapar y booleanos `true`/`false` (0/1 de SQLite ya llegan como bool).
"""
import hashlib
import json
from typing import Any, Iterable, Mapping


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def table_checksum(rows: Iterable[Mapping[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in sorted(rows, key=lambda r: r["id"]):
        digest.update(("%s\t%s\n" % (row["id"], canonical_json(row["data"]))).encode("utf-8"))
    return digest.hexdigest()
