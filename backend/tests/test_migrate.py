import multiprocessing
import os
import stat
import sqlite3
from pathlib import Path

import pytest

from acceso.migrate import MigrationError, MigrationResult, migrate

LEGACY_SQL = Path(__file__).parent / "fixtures" / "legacy_v2.sql"
V3_SQL = Path(__file__).parent / "fixtures" / "legacy_v3.sql"


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
    assert result.to_version == 4
    assert result.backup_path.name == "access_control_backup_v2.sqlite"
    assert rows(result.backup_path, "SELECT COUNT(*) FROM users") == [(1,)]

    assert rows(db, "SELECT holder_id, kind, name, department, address, notes FROM holders") == [
        (1, "persona", "Miguel Maldonado", "Fraccionamiento", "AMADEO 1260", "")
    ]
    assert rows(db, "SELECT * FROM holder_permissions") == [(1, 0)]
    assert rows(db, "SELECT output_mask FROM permissions WHERE permission_id=0") == [(15,)]
    assert rows(db, "SELECT output_id FROM outputs ORDER BY output_id") == [(0,), (1,), (2,), (3,)]
    assert rows(
        db, "SELECT output_id IS NULL FROM control_buttons WHERE control_id=1 AND button=2"
    ) == [(1,)]
    assert rows(db, "SELECT COUNT(*) FROM cards") == [(2,)]
    assert rows(db, "PRAGMA user_version") == [(4,)]
    assert rows(db, "SELECT pin FROM holders") == [(None,)]
    assert rows(db, "SELECT allow_pin FROM permissions") == [(0,)]

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

    assert result == MigrationResult(4, 4, None)
    assert len(list(tmp_path.glob("*_backup_v2.sqlite"))) == 1


def test_missing_file_creates_fresh_schema(tmp_path):
    db = tmp_path / "nueva.sqlite"

    result = migrate(db)

    assert result == MigrationResult(0, 4, None)
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

    assert set(versions) == {2, 4}
    assert len(list(tmp_path.glob("*_backup_v2.sqlite"))) == 1


def test_failed_conversion_can_be_retried(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_legacy(db)
    conn = sqlite3.connect(str(db))
    conn.execute("UPDATE users SET name='  '")  # v3 exige nombre no vacío
    conn.commit()
    conn.close()

    with pytest.raises(MigrationError) as exc:
        migrate(db)
    assert str(exc.value).startswith("No se pudo migrar la base")
    assert isinstance(exc.value.__cause__, sqlite3.Error)
    assert rows(db, "PRAGMA user_version") == [(0,)]
    assert rows(db, "SELECT COUNT(*) FROM users") == [(1,)]
    first_backup = tmp_path / "access_control_backup_v2.sqlite"
    assert rows(first_backup, "SELECT COUNT(*) FROM users") == [(1,)]

    conn = sqlite3.connect(str(db))
    conn.execute("UPDATE users SET name='Miguel Maldonado'")
    conn.commit()
    conn.close()
    result = migrate(db)

    assert result.from_version == 2 and result.to_version == 4
    assert result.backup_path == first_backup
    assert rows(db, "PRAGMA user_version") == [(4,)]
    kept = [p for p in tmp_path.glob("access_control_backup_v2.*.sqlite")]
    assert len(kept) == 1
    assert rows(kept[0], "SELECT name FROM users") == [("  ",)]
    assert rows(first_backup, "SELECT name FROM users") == [("Miguel Maldonado",)]
    assert not list(tmp_path.glob("*.tmp"))


def make_v3(path):
    conn = sqlite3.connect(str(path))
    conn.executescript(V3_SQL.read_text())
    conn.close()


def _dump(path):
    conn = sqlite3.connect(str(path))
    try:
        out = {}
        for (table,) in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            out[table] = [tuple(r) for r in conn.execute("SELECT * FROM %s ORDER BY 1, 2" % table)]
        return out
    finally:
        conn.close()


def test_migrates_v3_to_v4_preserving_rows(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v3(db)
    before = _dump(db)

    result = migrate(db)

    assert (result.from_version, result.to_version) == (3, 4)
    assert result.backup_path.name == "access_control_backup_v3.sqlite"
    assert rows(result.backup_path, "PRAGMA user_version") == [(3,)]
    assert _dump(result.backup_path) == before
    assert rows(db, "PRAGMA user_version") == [(4,)]
    after = _dump(db)
    for table, content in before.items():
        if table == "holders":
            assert [r + (None,) for r in content] == after[table]
        elif table == "permissions":
            assert [r + (0,) for r in content] == after[table]
        else:
            assert content == after[table]
    assert not list(tmp_path.glob("*.tmp"))
    assert migrate(db) == MigrationResult(4, 4, None)
    assert len(list(tmp_path.glob("*_backup_v3*.sqlite"))) == 1


def _schema_shape(path):
    conn = sqlite3.connect(str(path))
    try:
        shape = {}
        for (table,) in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            shape[table] = (
                [tuple(r) for r in conn.execute("PRAGMA table_info(%s)" % table)],
                sorted(tuple(r[1:]) for r in conn.execute("PRAGMA index_list(%s)" % table)),
            )
        return shape
    finally:
        conn.close()


def test_migrated_v3_and_fresh_v4_have_identical_schema(tmp_path):
    migrated, fresh = tmp_path / "migrated.sqlite", tmp_path / "fresh.sqlite"
    make_v3(migrated)
    migrate(migrated)
    migrate(fresh)

    shape = _schema_shape(migrated)
    assert shape == _schema_shape(fresh)
    assert ("holders_pin", 1, "c", 0) in [r[:4] for r in shape["holders"][1]]

    for path in (migrated, fresh):
        conn = sqlite3.connect(str(path))
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("INSERT INTO holders(kind, name, pin) VALUES ('persona', 'A', '0123')")
        for bad in ("123", "1234567", "12a4", "12 4", "١٢٣٤"):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("INSERT INTO holders(kind, name, pin) VALUES ('persona', 'B', ?)", (bad,))
        with pytest.raises(sqlite3.IntegrityError):  # unicidad
            conn.execute("INSERT INTO holders(kind, name, pin) VALUES ('persona', 'C', '0123')")
        conn.execute("INSERT INTO holders(kind, name) VALUES ('persona', 'D')")
        conn.execute("INSERT INTO holders(kind, name) VALUES ('persona', 'E')")  # NULL repetido
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE permissions SET allow_pin = 2")
        conn.close()


def test_failed_v3_migration_keeps_v3_and_can_retry(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v3(db)
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE holders_pin (x)")  # choca con el nombre del índice
    conn.commit()
    conn.close()

    with pytest.raises(MigrationError) as exc:
        migrate(db)
    assert "sigue en v3" in str(exc.value)
    assert rows(db, "PRAGMA user_version") == [(3,)]
    assert "pin" not in [r[1] for r in rows(db, "PRAGMA table_info(holders)")]
    assert not os.path.exists(str(db) + ".tmp")

    conn = sqlite3.connect(str(db))
    conn.execute("DROP TABLE holders_pin")
    conn.commit()
    conn.close()
    assert migrate(db).to_version == 4


def test_existing_v3_backup_is_rotated(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v3(db)
    (tmp_path / "access_control_backup_v3.sqlite").write_bytes(b"viejo")

    migrate(db)

    assert rows(tmp_path / "access_control_backup_v3.sqlite", "PRAGMA user_version") == [(3,)]
    kept = list(tmp_path.glob("access_control_backup_v3.*.sqlite"))
    assert len(kept) == 1 and kept[0].read_bytes() == b"viejo"


def test_backup_is_private_and_failed_attempts_keep_at_most_three_dated_copies(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_legacy(db)
    conn = sqlite3.connect(str(db))
    conn.execute("UPDATE users SET name='  '")
    conn.commit()
    conn.close()
    for i in range(6):
        with pytest.raises(MigrationError):
            migrate(db)
        os.utime(str(tmp_path / "access_control_backup_v2.sqlite"), (1_700_000_000 + i, 1_700_000_000 + i))
    current = tmp_path / "access_control_backup_v2.sqlite"
    assert stat.S_IMODE(current.stat().st_mode) == 0o600
    dated = list(tmp_path.glob("access_control_backup_v2.*.sqlite"))
    assert 1 <= len(dated) <= 3
    assert not list(tmp_path.glob("*.tmp"))


def test_v3_backup_mode_is_0600_and_pruned(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v3(db)
    for i in range(5):
        (tmp_path / ("access_control_backup_v3.2026010%d-000000.sqlite" % i)).write_bytes(b"x")
        os.utime(str(tmp_path / ("access_control_backup_v3.2026010%d-000000.sqlite" % i)),
                 (1_700_000_000 + i, 1_700_000_000 + i))
    result = migrate(db)
    assert stat.S_IMODE(result.backup_path.stat().st_mode) == 0o600
    assert len(list(tmp_path.glob("access_control_backup_v3.*.sqlite"))) == 3
