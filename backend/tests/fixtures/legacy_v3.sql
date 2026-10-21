CREATE TABLE IF NOT EXISTS holders (holder_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('persona','domicilio')), name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  department TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS permissions (permission_id INTEGER PRIMARY KEY CHECK(permission_id BETWEEN 0 AND 31),
  name TEXT NOT NULL, output_mask INTEGER NOT NULL CHECK(output_mask BETWEEN 0 AND 15),
  reader_mask INTEGER NOT NULL CHECK(reader_mask BETWEEN 0 AND 15), weekday_mask INTEGER NOT NULL CHECK(weekday_mask BETWEEN 0 AND 127),
  start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439), end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 0 AND 1439));
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

INSERT INTO outputs VALUES (0,3000,3,1),(1,3000,12,1),(2,3000,0,1),(3,3000,0,1);
INSERT INTO permissions VALUES (0,'Acceso total',15,15,127,0,0),(1,'Noches',3,15,127,1080,360);
INSERT INTO holders VALUES (1,'persona','Miguel Maldonado','Fraccionamiento','AMADEO 1260','nota'),(2,'domicilio','Casa 2','','','');
INSERT INTO holder_permissions VALUES (1,0),(2,1);
INSERT INTO cards VALUES (8518512,1,''),(111,1,'Llavero');
INSERT INTO controls VALUES (1,1,'Control 1');
INSERT INTO control_buttons VALUES (1,0,5001,0),(1,2,5003,NULL);
INSERT INTO access_logs(log_id, timestamp, allowed, source, holder_id, holder_name, holder_kind, credential_label, control_id, code, device_id, output_id, reason) VALUES (1,1790000000,1,0,1,'Miguel Maldonado','persona','Llavero',NULL,111,0,0,0),(2,1790000100,0,0,NULL,NULL,NULL,NULL,NULL,999,1,NULL,1);
PRAGMA user_version=3;
