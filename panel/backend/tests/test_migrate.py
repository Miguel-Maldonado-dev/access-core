import multiprocessing
import os
import re
import stat
import sqlite3
import time
from pathlib import Path

import pytest

from acceso.migrate import MigrationError, MigrationResult, migrate

LEGACY_SQL = Path(__file__).parent / "fixtures" / "legacy_v2.sql"
V3_SQL = Path(__file__).parent / "fixtures" / "legacy_v3.sql"
V4_SQL = Path(__file__).parent / "fixtures" / "legacy_v4.sql"
V5_SQL = Path(__file__).parent / "fixtures" / "legacy_v5.sql"

# Columnas que agrega v6; los volcados las omiten para comparar con el contenido anterior.
V6_COLUMNS = ("alias", "uuid", "updated_at", "origin")


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
    assert result.to_version == 6
    assert result.backup_path.name == "access_control_backup_v2.sqlite"
    assert rows(result.backup_path, "SELECT COUNT(*) FROM users") == [(1,)]

    assert rows(db, "SELECT holder_id, kind, name, department, address, notes FROM holders") == [
        (1, "persona", "Miguel Maldonado", "Fraccionamiento", "AMADEO 1260", "")
    ]
    assert rows(db, "SELECT holder_id, permission_id FROM holder_permissions") == [(1, 0)]
    assert rows(db, "SELECT output_mask FROM permissions WHERE permission_id=0") == [(15,)]
    assert rows(db, "SELECT output_id FROM outputs ORDER BY output_id") == [(0,), (1,), (2,), (3,)]
    assert rows(
        db, "SELECT output_id IS NULL FROM control_buttons WHERE control_id=1 AND button=2"
    ) == [(1,)]
    assert rows(db, "SELECT COUNT(*) FROM cards") == [(2,)]
    assert rows(db, "PRAGMA user_version") == [(6,)]
    assert rows(db, "SELECT pin FROM holders") == [(None,)]
    assert rows(db, "SELECT card_reader_mask, pin_reader_mask, allow_rf FROM permissions") == [
        (15, 0, 1)]

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
        assert not [c for c in cols if c.startswith("pin_") and c != "pin_reader_mask"]


def test_second_run_is_noop(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_legacy(db)
    migrate(db)

    result = migrate(db)

    assert result == MigrationResult(6, 6, None)
    assert len(list(tmp_path.glob("*_backup_v2.sqlite"))) == 1


def test_missing_file_creates_fresh_schema(tmp_path):
    db = tmp_path / "nueva.sqlite"

    result = migrate(db)

    assert result == MigrationResult(0, 6, None)
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

    assert set(versions) == {2, 6}
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

    assert result.from_version == 2 and result.to_version == 6
    assert result.backup_path == first_backup
    assert rows(db, "PRAGMA user_version") == [(6,)]
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
            cols = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)
                    if r[1] not in V6_COLUMNS]
            out[table] = [tuple(r) for r in conn.execute(
                "SELECT %s FROM %s ORDER BY 1, 2" % (", ".join(cols), table))]
        return out
    finally:
        conn.close()


def test_migrates_v3_to_v6_preserving_rows(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v3(db)
    before = _dump(db)

    result = migrate(db)

    assert (result.from_version, result.to_version) == (3, 6)
    assert result.backup_path.name == "access_control_backup_v3.sqlite"
    assert rows(result.backup_path, "PRAGMA user_version") == [(3,)]
    assert _dump(result.backup_path) == before
    assert rows(db, "PRAGMA user_version") == [(6,)]
    after = _dump(db)
    for table, content in before.items():
        if table == "holders":
            assert [r + (None,) for r in content] == after[table]
        elif table == "permissions":  # (id, nombre, salidas, lectores, días, desde, hasta)
            assert [r[:3] + (r[3], 0) + r[4:] + (1,) for r in content] == after[table]
        else:
            assert content == after[table]
    assert not list(tmp_path.glob("*.tmp"))
    assert migrate(db) == MigrationResult(6, 6, None)
    assert len(list(tmp_path.glob("*_backup_v3*.sqlite"))) == 1


def _norm_sql(sql):
    sql = sql.replace('"', "").replace("IF NOT EXISTS ", "")
    return " ".join(sql.split()).replace("( ", "(").replace(" )", ")")


def _schema_shape(path):
    conn = sqlite3.connect(str(path))
    try:
        shape = {}
        for (table,) in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            shape[table] = (
                [tuple(r) for r in conn.execute("PRAGMA table_info(%s)" % table)],
                sorted(tuple(r[1:]) for r in conn.execute("PRAGMA index_list(%s)" % table)),
                sorted(tuple(r[2:]) for r in conn.execute("PRAGMA foreign_key_list(%s)" % table)),
            )
        shape["_sql"] = sorted(
            (name, _norm_sql(sql)) for name, sql in conn.execute(
                "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL"
                " AND name NOT LIKE 'sqlite_%'"))
        return shape
    finally:
        conn.close()


def test_migrated_v3_and_fresh_v6_have_identical_schema(tmp_path):
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
        new = "INSERT INTO holders(kind, name, pin, uuid, updated_at)" \
              " VALUES ('persona', ?, ?, lower(hex(randomblob(16))), 1)"
        conn.execute(new, ("A", "0123"))
        for bad in ("123", "1234567", "12a4", "12 4", "١٢٣٤"):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(new, ("B", bad))
        with pytest.raises(sqlite3.IntegrityError):  # unicidad
            conn.execute(new, ("C", "0123"))
        conn.execute(new, ("D", None))
        conn.execute(new, ("E", None))  # NULL repetido
        for bad_set in ("allow_rf = 2", "card_reader_mask = 16", "pin_reader_mask = -1"):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute("UPDATE permissions SET " + bad_set)
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
    assert migrate(db).to_version == 6


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


def make_v4(path):
    conn = sqlite3.connect(str(path))
    conn.executescript(V4_SQL.read_text())
    conn.close()


def make_v5(path):
    conn = sqlite3.connect(str(path))
    conn.executescript(V5_SQL.read_text())
    conn.close()


def test_v4_fixture_is_really_v4(tmp_path):
    db = tmp_path / "v4.sqlite"
    make_v4(db)
    cols = [r[1] for r in rows(db, "PRAGMA table_info(permissions)")]
    assert "allow_pin" in cols and "reader_mask" in cols
    assert rows(db, "PRAGMA user_version") == [(4,)]


def test_migrates_v4_to_v6_preserving_every_row(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v4(db)
    before = _dump(db)

    result = migrate(db)

    assert (result.from_version, result.to_version) == (4, 6)
    assert result.backup_path.name == "access_control_backup_v4.sqlite"
    assert stat.S_IMODE(result.backup_path.stat().st_mode) == 0o600
    assert _dump(result.backup_path) == before
    assert rows(db, "PRAGMA user_version") == [(6,)]
    after = _dump(db)
    for table, content in before.items():
        if table != "permissions":
            assert content == after[table], table
    assert before["holder_permissions"] == [(1, 0), (1, 1), (2, 2)]
    assert rows(db, "SELECT permission_id, name, output_mask, card_reader_mask, pin_reader_mask,"
                    " weekday_mask, start_minute, end_minute, allow_rf FROM permissions"
                    " ORDER BY permission_id") == [
        (0, "Acceso total", 15, 15, 0, 127, 0, 0, 1),
        (1, "Solo lector 1 con PIN", 3, 5, 5, 31, 480, 1080, 1),
        (2, "Sin lectores", 1, 0, 0, 127, 0, 0, 1),
    ]
    assert rows(db, "PRAGMA foreign_key_check") == []
    assert not list(tmp_path.glob("*.tmp"))
    assert migrate(db) == MigrationResult(6, 6, None)
    assert len(list(tmp_path.glob("*_backup_v4*.sqlite"))) == 1
    # el borrado en cascada sigue funcionando tras la reconstrucción
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("DELETE FROM permissions WHERE permission_id = 1")
    assert [tuple(r) for r in conn.execute(
        "SELECT holder_id, permission_id FROM holder_permissions ORDER BY 1, 2")] == [(1, 0), (2, 2)]
    conn.close()


@pytest.mark.parametrize("maker", [make_legacy, make_v3, make_v4, make_v5])
def test_migrated_and_fresh_v6_have_identical_schema(tmp_path, maker):
    migrated, fresh = tmp_path / "migrated.sqlite", tmp_path / "fresh.sqlite"
    maker(migrated)
    migrate(migrated)
    migrate(fresh)
    assert _schema_shape(migrated) == _schema_shape(fresh)


def test_failed_v4_migration_keeps_v4_and_can_retry(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v4(db)
    before = _dump(db)
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE permissions_v5 (x)")  # choca con la tabla temporal
    conn.commit()
    conn.close()

    with pytest.raises(MigrationError) as exc:
        migrate(db)
    assert "sigue en v4" in str(exc.value)
    assert rows(db, "PRAGMA user_version") == [(4,)]
    assert "allow_pin" in [r[1] for r in rows(db, "PRAGMA table_info(permissions)")]

    conn = sqlite3.connect(str(db))
    conn.execute("DROP TABLE permissions_v5")
    conn.commit()
    conn.close()
    assert migrate(db).to_version == 6
    assert _dump(db)["holder_permissions"] == before["holder_permissions"]


def test_v4_backup_rotates_and_prunes(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v4(db)
    for i in range(5):
        path = tmp_path / ("access_control_backup_v4.2026010%d-000000.sqlite" % i)
        path.write_bytes(b"x")
        os.utime(str(path), (1_700_000_000 + i, 1_700_000_000 + i))
    (tmp_path / "access_control_backup_v4.sqlite").write_bytes(b"viejo")
    result = migrate(db)
    assert rows(result.backup_path, "PRAGMA user_version") == [(4,)]
    assert len(list(tmp_path.glob("access_control_backup_v4.*.sqlite"))) == 3


def _v4_with_orphans(path, *extra):
    make_v4(path)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys=OFF")
    for sql in extra:
        conn.execute(sql)
    conn.commit()
    conn.close()


@pytest.mark.parametrize("orphan", [(99, 0), (1, 7)])
def test_v4_pre_existing_orphans_do_not_block_and_are_kept(tmp_path, orphan):
    db = tmp_path / "access_control.sqlite"
    _v4_with_orphans(db, "INSERT INTO holder_permissions VALUES (%d, %d)" % orphan)
    before = _dump(db)

    result = migrate(db)

    assert result.to_version == 6
    assert rows(db, "PRAGMA user_version") == [(6,)]
    assert _dump(db)["holder_permissions"] == before["holder_permissions"]
    assert orphan in _dump(db)["holder_permissions"]


def test_rebuild_that_loses_a_permission_aborts_and_keeps_v4(tmp_path, monkeypatch):
    from acceso import migrate as m
    db = tmp_path / "access_control.sqlite"
    make_v4(db)
    before = _dump(db)
    real = m._rebuild_permissions

    def lossy(conn):
        real(conn)
        conn.execute("DELETE FROM permissions WHERE permission_id = 1")

    monkeypatch.setattr(m, "_rebuild_permissions", lossy)
    with pytest.raises(MigrationError) as exc:
        migrate(db)
    assert "sigue en v4" in str(exc.value)
    assert rows(db, "PRAGMA user_version") == [(4,)]
    assert _dump(db) == before


# --- v5 -> v6 ---------------------------------------------------------------------------------

REPLICATED = ("holders", "cards", "controls", "control_buttons", "permissions",
              "holder_permissions", "outputs")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def test_v5_fixture_is_really_v5(tmp_path):
    db = tmp_path / "v5.sqlite"
    make_v5(db)
    assert rows(db, "PRAGMA user_version") == [(5,)]
    assert "uuid" not in [r[1] for r in rows(db, "PRAGMA table_info(holders)")]
    assert "card_reader_mask" in [r[1] for r in rows(db, "PRAGMA table_info(permissions)")]


def test_migrates_v5_to_v6_keeping_rows_with_unique_uuids_and_empty_outbox(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v5(db)
    before = _dump(db)
    t0 = int(time.time() * 1000)

    result = migrate(db)

    assert (result.from_version, result.to_version) == (5, 6)
    assert result.backup_path.name == "access_control_backup_v5.sqlite"
    assert stat.S_IMODE(result.backup_path.stat().st_mode) == 0o600
    assert _dump(result.backup_path) == before
    assert rows(result.backup_path, "PRAGMA user_version") == [(5,)]
    assert rows(db, "PRAGMA user_version") == [(6,)]
    after = _dump(db)
    for table, content in before.items():
        assert content == after[table], table  # todas las filas, sin cambios (access_logs incluida)
    assert rows(db, "PRAGMA foreign_key_check") == []

    all_uuids = []
    for table in REPLICATED:
        stamps = rows(db, "SELECT uuid, updated_at, origin FROM %s" % table)
        assert len(stamps) == len(before[table]) > 0, table
        for stamp_uuid, updated_at, origin in stamps:
            assert UUID_RE.match(stamp_uuid), table
            assert t0 <= updated_at <= int(time.time() * 1000), table
            assert origin == "local"
        all_uuids += [s[0] for s in stamps]
    assert len(set(all_uuids)) == len(all_uuids)

    assert rows(db, "SELECT output_id, alias FROM outputs ORDER BY output_id") == [
        (0, ""), (1, ""), (2, ""), (3, "")]
    assert rows(db, "SELECT COUNT(*) FROM sync_outbox") == [(0,)]
    assert rows(db, "SELECT id, applying FROM sync_guard") == [(1, 0)]
    assert rows(db, "SELECT COUNT(*) FROM sync_state") == [(0,)]
    assert not list(tmp_path.glob("*.tmp"))
    assert migrate(db) == MigrationResult(6, 6, None)
    assert len(list(tmp_path.glob("*_backup_v5*.sqlite"))) == 1


def test_migrated_v6_tracks_changes_cascades_and_keeps_pin_rules(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v5(db)
    migrate(db)
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    assert conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0] == 21
    conn.execute("UPDATE cards SET description='x' WHERE card_code=111")
    conn.execute("DELETE FROM permissions WHERE permission_id=1")  # cascada a holder_permissions
    ops = sorted(tuple(r) for r in conn.execute("SELECT table_name, op FROM sync_outbox"))
    assert ops == [("cards", "upsert"), ("holder_permissions", "delete"), ("permissions", "delete")]
    assert [tuple(r) for r in conn.execute("SELECT holder_id, permission_id FROM holder_permissions"
                                           " ORDER BY 1, 2")] == [(1, 0), (2, 2)]
    with pytest.raises(sqlite3.IntegrityError):  # el índice único del PIN sobrevive a la reconstrucción
        conn.execute("UPDATE holders SET pin='123456' WHERE holder_id=2")
    conn.close()


def test_failed_v5_migration_keeps_v5_and_can_retry(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v5(db)
    before = _dump(db)
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE holders_v6 (x)")  # choca con la tabla temporal
    conn.commit()
    conn.close()

    with pytest.raises(MigrationError) as exc:
        migrate(db)
    assert "sigue en v5" in str(exc.value)
    assert rows(db, "PRAGMA user_version") == [(5,)]
    assert "uuid" not in [r[1] for r in rows(db, "PRAGMA table_info(holders)")]
    assert rows(db, "SELECT name FROM sqlite_master WHERE name LIKE 'sync_%'") == []
    assert not os.path.exists(str(db) + ".tmp")

    conn = sqlite3.connect(str(db))
    conn.execute("DROP TABLE holders_v6")
    conn.commit()
    conn.close()
    assert migrate(db).to_version == 6
    after = _dump(db)
    assert {t: after[t] for t in before} == before


def test_v6_failure_after_legacy_step_leaves_v5_and_retry_finishes(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v4(db)
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE cards_v6 (x)")
    conn.commit()
    conn.close()

    with pytest.raises(MigrationError) as exc:
        migrate(db)
    assert "sigue en v5" in str(exc.value)
    assert rows(db, "PRAGMA user_version") == [(5,)]
    assert (tmp_path / "access_control_backup_v4.sqlite").exists()

    conn = sqlite3.connect(str(db))
    conn.execute("DROP TABLE cards_v6")
    conn.commit()
    conn.close()
    result = migrate(db)
    assert (result.from_version, result.to_version) == (5, 6)
    assert result.backup_path.name == "access_control_backup_v5.sqlite"
    assert rows(db, "SELECT COUNT(*) FROM cards WHERE uuid IS NOT NULL") == [(2,)]


def test_chained_migration_takes_only_the_origin_backup(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v3(db)
    result = migrate(db)
    assert (result.from_version, result.to_version) == (3, 6)
    assert [p.name for p in tmp_path.glob("*_backup_*")] == ["access_control_backup_v3.sqlite"]


def test_v5_backup_rotates_and_prunes(tmp_path):
    db = tmp_path / "access_control.sqlite"
    make_v5(db)
    for i in range(5):
        path = tmp_path / ("access_control_backup_v5.2026010%d-000000.sqlite" % i)
        path.write_bytes(b"x")
        os.utime(str(path), (1_700_000_000 + i, 1_700_000_000 + i))
    (tmp_path / "access_control_backup_v5.sqlite").write_bytes(b"viejo")
    result = migrate(db)
    assert rows(result.backup_path, "PRAGMA user_version") == [(5,)]
    assert stat.S_IMODE(result.backup_path.stat().st_mode) == 0o600
    assert len(list(tmp_path.glob("access_control_backup_v5.*.sqlite"))) == 3


def test_migrated_and_fresh_v6_have_identical_triggers_and_indexes(tmp_path):
    migrated, fresh = tmp_path / "migrated.sqlite", tmp_path / "fresh.sqlite"
    make_v5(migrated)
    migrate(migrated)
    migrate(fresh)

    def objects(path):
        return sorted((t, n, tbl, _norm_sql(sql)) for t, n, tbl, sql in rows(
            path, "SELECT type, name, tbl_name, sql FROM sqlite_master"
                  " WHERE type IN ('trigger', 'index') AND sql IS NOT NULL"))

    assert objects(migrated) == objects(fresh)
    assert len([o for o in objects(fresh) if o[0] == "trigger"]) == 21
