CREATE TABLE IF NOT EXISTS holders (holder_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('persona','domicilio')), name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  department TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  pin TEXT CHECK(pin IS NULL OR (length(pin) BETWEEN 4 AND 6 AND pin NOT GLOB '*[^0-9]*')));
CREATE TABLE IF NOT EXISTS permissions (permission_id INTEGER PRIMARY KEY CHECK(permission_id BETWEEN 0 AND 31),
  name TEXT NOT NULL, output_mask INTEGER NOT NULL CHECK(output_mask BETWEEN 0 AND 15),
  reader_mask INTEGER NOT NULL CHECK(reader_mask BETWEEN 0 AND 15), weekday_mask INTEGER NOT NULL CHECK(weekday_mask BETWEEN 0 AND 127),
  start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439), end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 0 AND 1439),
  allow_pin INTEGER NOT NULL DEFAULT 0 CHECK(allow_pin IN (0,1)));
CREATE TABLE IF NOT EXISTS holder_permissions (
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE, PRIMARY KEY(holder_id, permission_id));
CREATE TABLE IF NOT EXISTS outputs (output_id INTEGER PRIMARY KEY CHECK(output_id BETWEEN 0 AND 3),
  duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 65535),
  reader_mask INTEGER NOT NULL CHECK(reader_mask BETWEEN 0 AND 15), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
CREATE TABLE IF NOT EXISTS cards (card_code INTEGER PRIMARY KEY CHECK(card_code BETWEEN 0 AND 4294967295),
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS controls (control_id INTEGER PRIMARY KEY,
  holder_id INTEGER NOT NULL REFERENCES holders(holder_id) ON DELETE CASCADE, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS control_buttons (
  control_id INTEGER NOT NULL REFERENCES controls(control_id) ON DELETE CASCADE,
  button INTEGER NOT NULL CHECK(button BETWEEN 0 AND 3),
  rf_code INTEGER NOT NULL UNIQUE CHECK(rf_code BETWEEN 0 AND 4294967295),
  output_id INTEGER REFERENCES outputs(output_id), PRIMARY KEY(control_id, button));
CREATE TABLE IF NOT EXISTS access_logs (log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL, allowed INTEGER NOT NULL, source INTEGER NOT NULL,
  holder_id INTEGER REFERENCES holders(holder_id) ON DELETE SET NULL, holder_name TEXT, holder_kind TEXT,
  credential_label TEXT, control_id INTEGER REFERENCES controls(control_id) ON DELETE SET NULL,
  code INTEGER, device_id INTEGER, output_id INTEGER, reason INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS access_logs_timestamp ON access_logs(timestamp);
CREATE INDEX IF NOT EXISTS access_logs_holder ON access_logs(holder_id);
CREATE UNIQUE INDEX IF NOT EXISTS holders_pin ON holders(pin);

INSERT INTO holders(holder_id, kind, name, department, address, notes, pin) VALUES
  (1, 'persona', 'Ana', 'Casa', 'AMADEO 1260', '', '123456'),
  (2, 'domicilio', 'Casa 7', '', '', 'nota', NULL);
INSERT INTO permissions(permission_id, name, output_mask, reader_mask, weekday_mask, start_minute, end_minute, allow_pin) VALUES
  (0, 'Acceso total', 15, 15, 127, 0, 0, 0),
  (1, 'Solo lector 1 con PIN', 3, 5, 31, 480, 1080, 1),
  (2, 'Sin lectores', 1, 0, 127, 0, 0, 1);
INSERT INTO holder_permissions(holder_id, permission_id) VALUES (1, 0), (1, 1), (2, 2);
INSERT INTO outputs VALUES (0,3000,3,1),(1,1500,12,1),(2,3000,0,1),(3,3000,0,0);
INSERT INTO cards(card_code, holder_id, description) VALUES (111, 1, 'Llavero'), (222, 2, '');
INSERT INTO controls(control_id, holder_id, description) VALUES (1, 1, 'Control 1');
INSERT INTO control_buttons(control_id, button, rf_code, output_id) VALUES (1, 0, 500, 0), (1, 1, 501, NULL);
INSERT INTO access_logs(timestamp, allowed, source, holder_id, holder_name, holder_kind, credential_label, code, device_id, output_id, reason)
  VALUES (1000, 1, 0, 1, 'Ana', 'persona', 'Llavero', 111, 0, 0, 0), (1001, 0, 3, NULL, NULL, NULL, 'PIN', NULL, 1, NULL, 8);
PRAGMA user_version=4;
