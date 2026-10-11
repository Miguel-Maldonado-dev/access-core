CREATE TABLE outputs (
      output_id INTEGER PRIMARY KEY CHECK(output_id BETWEEN 0 AND 5),
      duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 65535),
      reader_mask INTEGER NOT NULL, enabled INTEGER NOT NULL);
CREATE TABLE permissions (
      permission_id INTEGER PRIMARY KEY CHECK(permission_id BETWEEN 0 AND 31), name TEXT NOT NULL,
      output_mask INTEGER NOT NULL, reader_mask INTEGER NOT NULL, weekday_mask INTEGER NOT NULL,
      start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL);
CREATE TABLE users (
      user_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', pin_salt BLOB, pin_hash BLOB);
CREATE TABLE user_permissions (
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, permission_id));
CREATE TABLE cards (
      card_code INTEGER PRIMARY KEY CHECK(card_code BETWEEN 0 AND 4294967295),
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      description TEXT NOT NULL DEFAULT '');
CREATE TABLE controls (
      control_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      description TEXT NOT NULL DEFAULT '');
CREATE TABLE control_buttons (
      control_id INTEGER NOT NULL REFERENCES controls(control_id) ON DELETE CASCADE,
      button INTEGER NOT NULL CHECK(button BETWEEN 0 AND 3),
      rf_code INTEGER NOT NULL UNIQUE CHECK(rf_code BETWEEN 0 AND 4294967295),
      output_id INTEGER REFERENCES outputs(output_id),
      PRIMARY KEY(control_id, button));
CREATE TABLE access_logs (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, allowed INTEGER NOT NULL,
      source INTEGER NOT NULL, user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
      control_id INTEGER REFERENCES controls(control_id) ON DELETE SET NULL,
      code INTEGER, device_id INTEGER, output_id INTEGER, reason INTEGER NOT NULL);
INSERT INTO users VALUES (1,'Miguel Maldonado','Fraccionamiento','AMADEO 1260',X'01',X'02');
INSERT INTO permissions VALUES (0,'Acceso total',63,15,127,0,0);
INSERT INTO user_permissions VALUES (1,0);
INSERT INTO outputs VALUES (0,3000,3,1),(1,3000,12,1),(2,3000,0,1),(3,3000,0,1),(4,3000,0,0);
INSERT INTO cards VALUES (8518512,1,''),(111,1,'Llavero');
INSERT INTO controls VALUES (1,1,'Control 1');
INSERT INTO control_buttons VALUES (1,0,10387716,0),(1,1,10387714,1),(1,2,555,4);
INSERT INTO access_logs(timestamp,allowed,source,user_id,control_id,code,device_id,output_id,reason) VALUES
 (1790000001,1,0,1,NULL,111,0,0,0),
 (1790000002,1,0,1,NULL,8518512,2,1,0),
 (1790000003,1,1,1,1,10387716,0,NULL,0),
 (1790000004,1,2,NULL,NULL,NULL,1,1,7),
 (1790000005,0,0,NULL,NULL,999,NULL,NULL,1);
