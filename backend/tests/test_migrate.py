import multiprocessing
import sqlite3
from pathlib import Path

import pytest

from acceso.migrate import MigrationError, MigrationResult, migrate

LEGACY_SQL = Path(__file__).parent / "fixtures" / "legacy_v2.sql"


def make_legacy(path):
    conn = sqlite3.connect(str(path))
    conn.executescript(LEGACY_SQL.read_text())
    conn.close()


def rows(path, sql):
    conn = sqlite3.connect(str(path))
    try:
        return [tuple(r) for r in conn.execute(sql).fetchall()]
    finally:
        conn.close()


def _migrate_worker(path):
    return migrate(Path(path)).from_version


def test_migrates_legacy_v2(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_legacy(db)

    result = migrate(db)

    assert result.from_version == 2
    assert result.to_version == 3
    assert result.backup_path.name == "access_control_backup_v2.sqlite"
    assert rows(result.backup_path, "SELECT COUNT(*) FROM users") == [(1,)]

    assert rows(db, "SELECT * FROM holders") == [
        (1, "persona", "Miguel Maldonado", "Fraccionamiento", "AMADEO 1260", "")
    ]
    assert rows(db, "SELECT * FROM holder_permissions") == [(1, 0)]
    assert rows(db, "SELECT output_mask FROM permissions WHERE permission_id=0") == [(15,)]
    assert rows(db, "SELECT output_id FROM outputs ORDER BY output_id") == [(0,), (1,), (2,), (3,)]
    assert rows(
        db, "SELECT output_id IS NULL FROM control_buttons WHERE control_id=1 AND button=2"
    ) == [(1,)]
    assert rows(db, "SELECT COUNT(*) FROM cards") == [(2,)]
    assert rows(db, "PRAGMA user_version") == [(3,)]

    def log(code_sql):
        return rows(
            db,
            "SELECT holder_name, holder_kind, credential_label FROM access_logs WHERE " + code_sql,
        )[0]

    assert log("source=0 AND code=111") == ("Miguel Maldonado", "persona", "Llavero")
    assert log("source=1") [2] == "Control 1"
    assert log("source=2")[0] is None
    assert log("source=0 AND code=8518512")[2] is None

    tables = {r[0] for r in rows(db, "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "users" not in tables and "user_permissions" not in tables
    assert not any(t.endswith("_v3") for t in tables)
    for table in tables:
        cols = [r[1] for r in rows(db, "PRAGMA table_info(%s)" % table)]
        assert not [c for c in cols if c.startswith("pin_")]


def test_second_run_is_noop(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_legacy(db)
    migrate(db)

    result = migrate(db)

    assert result == MigrationResult(3, 3, None)
    assert len(list(tmp_path.glob("*_backup_v2.sqlite"))) == 1


def test_missing_file_creates_fresh_schema(tmp_path):
    db = tmp_path / "nueva.sqlite"

    result = migrate(db)

    assert result == MigrationResult(0, 3, None)
    assert rows(db, "SELECT COUNT(*) FROM outputs") == [(4,)]


def test_v1_schema_rejected(tmp_path):
    db = tmp_path / "v1.sqlite"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE users (card_code INTEGER PRIMARY KEY, name TEXT)")
    conn.close()

    with pytest.raises(MigrationError) as exc:
        migrate(db)
    assert str(exc.value) == "Base v1 no soportada: ábrela primero con access_control_admin_gui.py"


def test_concurrent_migrations_run_once(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_legacy(db)

    with multiprocessing.get_context("spawn").Pool(2) as pool:
        versions = pool.map(_migrate_worker, [str(db), str(db)])

    assert set(versions) == {2, 3}
    assert len(list(tmp_path.glob("*_backup_v2.sqlite"))) == 1
