#!/usr/bin/env python3
"""Administrador Tkinter de control de acceso usando SQLite.

La base ``access_control.sqlite`` se crea junto a este archivo. El segundo
programa de esta carpeta (el simulador) reutiliza SQLiteStore de este modulo.

Un usuario puede tener varias tarjetas y varios controles RF de 4 botones.
Los permisos se asignan al usuario y aplican a todas sus tarjetas y controles.
"""
import hashlib
import os
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional
import tkinter as tk
from tkinter import messagebox, ttk

READER_NAMES = ("Reader1", "Reader2", "Reader3", "Reader4")
OUTPUT_NAMES = ("Relay1", "Relay2", "Relay3", "Relay4")
# El firmware abre directamente: boton de salida 1 -> Relay1, boton de salida 2 -> Relay2.
EXIT_BUTTON_NAMES = ("Boton salida 1", "Boton salida 2")
EXIT_BUTTON_OUTPUTS = (0, 1)
CONTROL_BUTTONS = 4
UNASSIGNED = "Sin asignar"
DAY_NAMES = ("Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom")
MAX_LOG_ENTRIES = 1000
MAX_CODE = 0xFFFFFFFF
LOG_SOURCE_CARD, LOG_SOURCE_RF, LOG_SOURCE_EXIT_BUTTON = range(3)
LOG_SOURCES = {LOG_SOURCE_CARD: "Tarjeta", LOG_SOURCE_RF: "Control RF", LOG_SOURCE_EXIT_BUTTON: "Boton salida"}
(LOG_ALLOWED, LOG_UNKNOWN_CARD, LOG_NO_OUTPUT, LOG_NO_PERMISSION, LOG_UART_ERROR,
 LOG_UNKNOWN_CONTROL, LOG_UNASSIGNED_BUTTON, LOG_EXIT_BUTTON) = range(8)
LOG_REASONS = {LOG_ALLOWED: "Permitido", LOG_UNKNOWN_CARD: "Tarjeta desconocida",
               LOG_NO_OUTPUT: "Sin salida", LOG_NO_PERMISSION: "Sin permiso",
               LOG_UART_ERROR: "Error UART", LOG_UNKNOWN_CONTROL: "Control desconocido",
               LOG_UNASSIGNED_BUTTON: "Boton sin salida", LOG_EXIT_BUTTON: "Boton de salida"}
# (salida, duracion ms, mascara de lectores). Relay3 y Relay4 inician sin lector asignado.
DEFAULT_OUTPUTS = ((0, 3000, 3), (1, 3000, 12)) + tuple((i, 3000, 0) for i in range(2, len(OUTPUT_NAMES)))

# Las tablas se definen por nombre para poder reconstruirlas durante la migracion.
TABLES = {
    "outputs": """{name} (
      output_id INTEGER PRIMARY KEY CHECK(output_id BETWEEN 0 AND 3),
      duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 65535),
      reader_mask INTEGER NOT NULL, enabled INTEGER NOT NULL)""",
    "permissions": """{name} (
      permission_id INTEGER PRIMARY KEY CHECK(permission_id BETWEEN 0 AND 31), name TEXT NOT NULL,
      output_mask INTEGER NOT NULL, reader_mask INTEGER NOT NULL, weekday_mask INTEGER NOT NULL,
      start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL)""",
    "users": """{name} (
      user_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', pin_salt BLOB, pin_hash BLOB)""",
    "user_permissions": """{name} (
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, permission_id))""",
    "cards": """{name} (
      card_code INTEGER PRIMARY KEY CHECK(card_code BETWEEN 0 AND 4294967295),
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      description TEXT NOT NULL DEFAULT '')""",
    "controls": """{name} (
      control_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      description TEXT NOT NULL DEFAULT '')""",
    "control_buttons": """{name} (
      control_id INTEGER NOT NULL REFERENCES controls(control_id) ON DELETE CASCADE,
      button INTEGER NOT NULL CHECK(button BETWEEN 0 AND 3),
      rf_code INTEGER NOT NULL UNIQUE CHECK(rf_code BETWEEN 0 AND 4294967295),
      output_id INTEGER REFERENCES outputs(output_id),
      PRIMARY KEY(control_id, button))""",
    "access_logs": """{name} (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, allowed INTEGER NOT NULL,
      source INTEGER NOT NULL, user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
      control_id INTEGER REFERENCES controls(control_id) ON DELETE SET NULL,
      code INTEGER, device_id INTEGER, output_id INTEGER, reason INTEGER NOT NULL)""",
}
USER_QUERY = ("SELECT u.*, COALESCE((SELECT SUM(1 << permission_id) FROM user_permissions WHERE user_id=u.user_id), 0) permission_mask, "
              "(SELECT COUNT(*) FROM cards WHERE user_id=u.user_id) card_count, "
              "(SELECT COUNT(*) FROM controls WHERE user_id=u.user_id) control_count FROM users u")
CARD_QUERY = "SELECT c.*, u.name FROM cards c JOIN users u ON u.user_id=c.user_id"
CONTROL_QUERY = "SELECT c.*, u.name FROM controls c JOIN users u ON u.user_id=c.user_id"


def table_sql(table, name=None): return "CREATE TABLE IF NOT EXISTS " + TABLES[table].format(name=name or table)


@dataclass
class User:
    user_id: int; name: str; department: str; address: str; permission_mask: int


@dataclass
class OutputConfig:
    output_id: int; duration_ms: int; reader_mask: int; enabled: bool


@dataclass
class Access:
    """Resultado de validar una tarjeta o un codigo RF."""
    reason: int
    user: Optional[User] = None
    output: Optional[OutputConfig] = None
    control_id: Optional[int] = None
    button: Optional[int] = None

    @property
    def allowed(self): return self.reason == LOG_ALLOWED


def output_config(row): return OutputConfig(row["output_id"], row["duration_ms"], row["reader_mask"], bool(row["enabled"]))


class SQLiteStore:
    """Modelo relacional y operaciones compartidas por ambas interfaces."""
    def __init__(self, directory: Path):
        self.path = directory / "access_control.sqlite"
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self._create_schema()

    def _create_schema(self):
        if "card_code" in {r["name"] for r in self.db.execute("PRAGMA table_info(users)")}:
            self._migrate_single_card_schema()
        self.db.executescript(";\n".join(table_sql(t) for t in TABLES) + ";")
        self.db.executemany("INSERT OR IGNORE INTO outputs VALUES (?, ?, ?, 1)", DEFAULT_OUTPUTS)
        # Quita las salidas que el panel ya no tiene (Relay5 y Relay6); sus botones quedan sin asignar.
        self.db.execute("UPDATE control_buttons SET output_id=NULL WHERE output_id >= ?", (len(OUTPUT_NAMES),))
        self.db.execute("DELETE FROM outputs WHERE output_id >= ?", (len(OUTPUT_NAMES),))
        if not self.db.execute("SELECT 1 FROM permissions").fetchone():
            self.db.execute("INSERT INTO permissions VALUES (0, 'Acceso total', ?, ?, 127, 0, 0)",
                            ((1 << len(OUTPUT_NAMES)) - 1, (1 << len(READER_NAMES)) - 1))
        self.db.commit()

    def _migrate_single_card_schema(self):
        """Convierte la base anterior (una tarjeta en users.card_code, 2 salidas y logs solo
        de tarjetas) al esquema actual. Antes se guarda una copia en *_backup_v1.sqlite."""
        shutil.copy2(self.path, self.path.with_name(self.path.stem + "_backup_v1.sqlite"))
        self.db.execute("PRAGMA foreign_keys = OFF")  # Evita las cascadas al reconstruir users.
        try:
            self.db.executescript(f"""
                BEGIN;
                {table_sql('cards')};
                INSERT INTO cards(card_code, user_id) SELECT card_code, user_id FROM users;
                {table_sql('users', 'users_new')};
                INSERT INTO users_new SELECT user_id, name, department, address, pin_salt, pin_hash FROM users;
                DROP TABLE users;
                ALTER TABLE users_new RENAME TO users;
                {table_sql('outputs', 'outputs_new')};
                INSERT INTO outputs_new SELECT output_id, duration_ms, reader_mask, enabled FROM outputs;
                DROP TABLE outputs;
                ALTER TABLE outputs_new RENAME TO outputs;
                {table_sql('access_logs', 'access_logs_new')};
                INSERT INTO access_logs_new(log_id, timestamp, allowed, source, user_id, code, device_id, output_id, reason)
                  SELECT log_id, timestamp, allowed, {LOG_SOURCE_CARD}, user_id, card_code, reader_id, output_id, reason FROM access_logs;
                DROP TABLE access_logs;
                ALTER TABLE access_logs_new RENAME TO access_logs;
                COMMIT;
            """)
        except sqlite3.Error:
            self.db.rollback(); raise
        finally:
            self.db.execute("PRAGMA foreign_keys = ON")

    def close(self): self.db.close()
    def list_outputs(self): return [output_config(r) for r in self.db.execute("SELECT * FROM outputs ORDER BY output_id")]
    def save_output(self, item):
        self.db.execute("INSERT INTO outputs VALUES (?, ?, ?, ?) ON CONFLICT(output_id) DO UPDATE SET duration_ms=excluded.duration_ms, reader_mask=excluded.reader_mask, enabled=excluded.enabled", (item.output_id, item.duration_ms, item.reader_mask, int(item.enabled))); self.db.commit()
    def list_permissions(self): return self.db.execute("SELECT * FROM permissions ORDER BY permission_id").fetchall()
    def save_permission(self, values):
        self.db.execute("INSERT INTO permissions VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(permission_id) DO UPDATE SET name=excluded.name, output_mask=excluded.output_mask, reader_mask=excluded.reader_mask, weekday_mask=excluded.weekday_mask, start_minute=excluded.start_minute, end_minute=excluded.end_minute", values); self.db.commit()
    def delete_permission(self, permission_id): self.db.execute("DELETE FROM permissions WHERE permission_id=?", (permission_id,)); self.db.commit()
    def list_users(self): return self.db.execute(USER_QUERY + " ORDER BY u.user_id").fetchall()
    def get_user(self, user_id): return self.db.execute("SELECT * FROM users WHERE user_id=?", (user_id,)).fetchone()
    def user_permissions(self, user_id): return {r[0] for r in self.db.execute("SELECT permission_id FROM user_permissions WHERE user_id=?", (user_id,))}
    def save_user(self, user_id, name, department, address, permission_ids, pin):
        if not name: raise ValueError("El nombre es obligatorio.")
        previous = self.get_user(user_id)
        salt, hashed = (previous["pin_salt"], previous["pin_hash"]) if previous else (None, None)
        if pin:
            salt = os.urandom(16); hashed = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 100000)
        with self.db:
            self.db.execute("INSERT INTO users(user_id,name,department,address,pin_salt,pin_hash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, department=excluded.department, address=excluded.address, pin_salt=excluded.pin_salt, pin_hash=excluded.pin_hash", (user_id, name, department, address, salt, hashed))
            self.db.execute("DELETE FROM user_permissions WHERE user_id=?", (user_id,))
            self.db.executemany("INSERT INTO user_permissions VALUES (?, ?)", ((user_id, p) for p in permission_ids))
    # Tambien borra sus tarjetas y controles (ON DELETE CASCADE).
    def delete_user(self, user_id): self.db.execute("DELETE FROM users WHERE user_id=?", (user_id,)); self.db.commit()

    def list_cards(self): return self.db.execute(CARD_QUERY + " ORDER BY c.user_id, c.card_code").fetchall()
    def get_card(self, card_code): return self.db.execute(CARD_QUERY + " WHERE c.card_code=?", (card_code,)).fetchone()
    def save_card(self, card_code, user_id, description):
        with self.db: self.db.execute("INSERT INTO cards VALUES (?, ?, ?) ON CONFLICT(card_code) DO UPDATE SET user_id=excluded.user_id, description=excluded.description", (card_code, user_id, description))
    def delete_card(self, card_code):
        with self.db: self.db.execute("DELETE FROM cards WHERE card_code=?", (card_code,))

    def list_controls(self): return [(c, self.control_buttons(c["control_id"])) for c in self.db.execute(CONTROL_QUERY + " ORDER BY c.user_id, c.control_id").fetchall()]
    def get_control(self, control_id): return self.db.execute(CONTROL_QUERY + " WHERE c.control_id=?", (control_id,)).fetchone()
    def control_buttons(self, control_id):
        """{boton: (codigo RF, salida o None)} de los botones que tienen codigo registrado."""
        return {r["button"]: (r["rf_code"], r["output_id"]) for r in self.db.execute("SELECT * FROM control_buttons WHERE control_id=?", (control_id,))}
    def save_control(self, control_id, user_id, description, buttons):
        """buttons: una tupla (codigo RF o None, salida o None) por boton. control_id=None crea
        un control nuevo. Regresa el ID del control."""
        codes = [code for code, _ in buttons if code is not None]
        if len(codes) != len(set(codes)): raise ValueError("Cada boton del control debe tener un codigo distinto.")
        for code in codes:
            owner = self.db.execute("SELECT control_id FROM control_buttons WHERE rf_code=? AND control_id IS NOT ?", (code, control_id)).fetchone()
            if owner: raise ValueError(f"El codigo {code} ya esta registrado en el control {owner['control_id']}.")
        with self.db:
            cursor = self.db.execute("INSERT INTO controls VALUES (?, ?, ?) ON CONFLICT(control_id) DO UPDATE SET user_id=excluded.user_id, description=excluded.description", (control_id, user_id, description))
            if control_id is None: control_id = cursor.lastrowid
            self.db.execute("DELETE FROM control_buttons WHERE control_id=?", (control_id,))
            self.db.executemany("INSERT INTO control_buttons VALUES (?, ?, ?, ?)", ((control_id, button, code, output) for button, (code, output) in enumerate(buttons) if code is not None))
        return control_id
    def delete_control(self, control_id):
        with self.db: self.db.execute("DELETE FROM controls WHERE control_id=?", (control_id,))

    def append_log(self, source, allowed, reason, user_id=None, code=None, device=None, output_id=None, control_id=None):
        """device es el lector (tarjeta), el boton 0-3 del control (RF) o el boton de salida 0-1."""
        self.db.execute("INSERT INTO access_logs(timestamp,allowed,source,user_id,control_id,code,device_id,output_id,reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (int(datetime.now().timestamp()), int(allowed), source, user_id, control_id, code, device, output_id, reason))
        self.db.execute("DELETE FROM access_logs WHERE log_id NOT IN (SELECT log_id FROM access_logs ORDER BY log_id DESC LIMIT ?)", (MAX_LOG_ENTRIES,)); self.db.commit()
    def log_access(self, source, access, code, device, reason=None):
        """Registra un resultado de authorize_card/authorize_rf; reason sustituye el motivo (p. ej. error UART)."""
        reason = access.reason if reason is None else reason
        self.append_log(source, reason == LOG_ALLOWED, reason, access.user.user_id if access.user else None, code, device,
                        access.output.output_id if access.output else None, access.control_id)
    def list_logs(self): return self.db.execute("SELECT l.*, u.name FROM access_logs l LEFT JOIN users u ON u.user_id=l.user_id ORDER BY l.log_id DESC").fetchall()
    def clear_logs(self): self.db.execute("DELETE FROM access_logs"); self.db.commit()

    def _load_user(self, user_id):
        r = self.db.execute(USER_QUERY + " WHERE u.user_id=?", (user_id,)).fetchone()
        return User(r["user_id"], r["name"], r["department"], r["address"], r["permission_mask"])
    def _permission_allows(self, user_id, output_id, reader, now):
        """Algun permiso del usuario cubre la salida, el dia y el horario. reader=None (control RF) no filtra por lector."""
        moment = now or datetime.now(); minute = moment.hour * 60 + moment.minute; day = 1 << moment.weekday()
        for p in self.db.execute("SELECT p.* FROM permissions p JOIN user_permissions up ON up.permission_id=p.permission_id WHERE up.user_id=?", (user_id,)):
            time_ok = p["start_minute"] == p["end_minute"] or (p["start_minute"] <= minute < p["end_minute"] if p["start_minute"] < p["end_minute"] else minute >= p["start_minute"] or minute < p["end_minute"])
            reader_ok = reader is None or p["reader_mask"] & (1 << reader)
            if p["output_mask"] & (1 << output_id) and reader_ok and p["weekday_mask"] & day and time_ok: return True
        return False
    def authorize_card(self, card, reader, now=None):
        row = self.db.execute("SELECT user_id FROM cards WHERE card_code=?", (card,)).fetchone()
        if not row: return Access(LOG_UNKNOWN_CARD)
        user = self._load_user(row["user_id"])
        output = self.db.execute("SELECT * FROM outputs WHERE enabled=1 AND (reader_mask & ?) != 0 ORDER BY output_id", (1 << reader,)).fetchone()
        if not output: return Access(LOG_NO_OUTPUT, user)
        if not self._permission_allows(user.user_id, output["output_id"], reader, now): return Access(LOG_NO_PERMISSION, user, output_config(output))
        return Access(LOG_ALLOWED, user, output_config(output))
    def authorize_rf(self, code, now=None):
        """La salida la define el boton del control; los permisos del usuario deciden si se activa."""
        row = self.db.execute("SELECT b.control_id, b.button, b.output_id, c.user_id FROM control_buttons b JOIN controls c ON c.control_id=b.control_id WHERE b.rf_code=?", (code,)).fetchone()
        if not row: return Access(LOG_UNKNOWN_CONTROL)
        user = self._load_user(row["user_id"]); control = {"control_id": row["control_id"], "button": row["button"]}
        if row["output_id"] is None: return Access(LOG_UNASSIGNED_BUTTON, user, **control)
        output = self.db.execute("SELECT * FROM outputs WHERE output_id=? AND enabled=1", (row["output_id"],)).fetchone()
        if not output: return Access(LOG_NO_OUTPUT, user, **control)
        if not self._permission_allows(user.user_id, row["output_id"], None, now): return Access(LOG_NO_PERMISSION, user, output_config(output), **control)
        return Access(LOG_ALLOWED, user, output_config(output), **control)


def mask(vars_): return sum(1 << i for i, v in enumerate(vars_) if v.get())
def set_mask(vars_, value):
    for i, v in enumerate(vars_): v.set(bool(value & (1 << i)))
def parse_time(value):
    hour, minute = (int(x) for x in value.split(":"));
    if not (0 <= hour < 24 and 0 <= minute < 60): raise ValueError("Horario invalido: HH:MM")
    return hour * 60 + minute
def parse_code(value, label):
    """Los codigos se muestran en decimal; tambien se acepta hexadecimal con prefijo 0x."""
    text = value.strip()
    try: code = int(text, 16) if text.lower().startswith("0x") else int(text)
    except ValueError: raise ValueError(f"{label} invalido: '{text}'. Usa un numero decimal.") from None
    if not 0 <= code <= MAX_CODE: raise ValueError(f"{label} fuera de rango (0 a 4294967295).")
    return code
def user_choice(row): return f"{row['user_id']}: {row['name']}"
def parse_user_choice(value):
    if not value: raise ValueError("Selecciona un usuario.")
    return int(value.split(":", 1)[0])
def button_text(item):
    if item is None: return "-"
    code, output = item
    return f"{code} -> {OUTPUT_NAMES[output] if output is not None else UNASSIGNED}"
def log_values(r):
    source, device = r["source"], r["device_id"]
    if source == LOG_SOURCE_RF:
        code = r["code"] if r["code"] is not None else "-"
        parts = ([f"Control {r['control_id']}"] if r["control_id"] is not None else []) + ([f"Boton {device + 1}"] if device is not None else [])
        device = " / ".join(parts) or "-"
    elif source == LOG_SOURCE_EXIT_BUTTON:
        code, device = "-", EXIT_BUTTON_NAMES[device] if device in range(len(EXIT_BUTTON_NAMES)) else "-"
    else:
        code, device = r["code"], READER_NAMES[device] if device in range(len(READER_NAMES)) else "-"
    output = OUTPUT_NAMES[r["output_id"]] if r["output_id"] in range(len(OUTPUT_NAMES)) else "-"
    return (datetime.fromtimestamp(r["timestamp"]).strftime("%Y-%m-%d %H:%M:%S"), "PERMITIDO" if r["allowed"] else "DENEGADO",
            LOG_SOURCES.get(source, "-"), r["name"] or "-", code, device, output, LOG_REASONS.get(r["reason"], "-"))


class AdminApp(tk.Tk):
    def __init__(self):
        super().__init__(); self.title("Administracion de control de acceso (SQLite)"); self.geometry("1200x680")
        self.store = SQLiteStore(Path(__file__).parent); self._build(); self.refresh()
        self.protocol("WM_DELETE_WINDOW", self.close)
    def tree(self, parent, columns, width=140):
        tree = ttk.Treeview(parent, columns=columns, show="headings")
        for col in columns: tree.heading(col, text=col); tree.column(col, width=width)
        return tree
    def _build(self):
        book = ttk.Notebook(self); book.pack(fill="both", expand=True, padx=10, pady=10)
        self.ut, self.ct, self.kt, self.pt, self.ot, self.lt = (ttk.Frame(book, padding=10) for _ in range(6))
        for tab, title in ((self.ut,"Usuarios"),(self.ct,"Tarjetas"),(self.kt,"Controles"),(self.pt,"Permisos"),(self.ot,"Salidas"),(self.lt,"Logs")): book.add(tab, text=title)
        self._users(); self._cards(); self._controls(); self._permissions(); self._outputs(); self._logs()
    def _users(self):
        self.ut.columnconfigure(1, weight=1); self.ut.rowconfigure(0, weight=1); form=ttk.LabelFrame(self.ut,text="Usuario",padding=8); form.grid(row=0,column=0,sticky="nsw",padx=(0,8))
        self.uv={x:tk.StringVar() for x in ("id","name","department","address","pin")}
        for row,(key,label) in enumerate((("id","ID"),("name","Nombre"),("department","Departamento"),("address","Domicilio"),("pin","PIN nuevo"))): ttk.Label(form,text=label).grid(row=row,column=0,sticky="w"); ttk.Entry(form,textvariable=self.uv[key],show="*" if key=="pin" else "",width=30).grid(row=row,column=1)
        self.upf=ttk.Frame(form); self.upf.grid(row=5,column=0,columnspan=2,sticky="w"); ttk.Button(form,text="Guardar",command=self.save_user).grid(row=6,column=0,pady=8); ttk.Button(form,text="Eliminar",command=self.delete_user).grid(row=6,column=1,pady=8)
        self.users=self.tree(self.ut,("ID","Nombre","Departamento","Tarjetas","Controles","Permisos")); self.users.grid(row=0,column=1,sticky="nsew"); self.users.bind("<<TreeviewSelect>>",self.select_user)
    def _cards(self):
        self.ct.columnconfigure(1,weight=1); self.ct.rowconfigure(0,weight=1); form=ttk.LabelFrame(self.ct,text="Tarjeta",padding=8); form.grid(row=0,column=0,sticky="nw",padx=(0,8))
        self.cv={x:tk.StringVar() for x in ("code","user","description")}
        ttk.Label(form,text="Codigo").grid(row=0,column=0,sticky="w"); ttk.Entry(form,textvariable=self.cv["code"],width=30).grid(row=0,column=1)
        ttk.Label(form,text="Usuario").grid(row=1,column=0,sticky="w"); self.card_user=ttk.Combobox(form,textvariable=self.cv["user"],state="readonly",width=28); self.card_user.grid(row=1,column=1)
        ttk.Label(form,text="Descripcion").grid(row=2,column=0,sticky="w"); ttk.Entry(form,textvariable=self.cv["description"],width=30).grid(row=2,column=1)
        ttk.Button(form,text="Guardar",command=self.save_card).grid(row=3,column=0,pady=8); ttk.Button(form,text="Eliminar",command=self.delete_card).grid(row=3,column=1,pady=8)
        self.cards=self.tree(self.ct,("Codigo","Usuario","Descripcion")); self.cards.grid(row=0,column=1,sticky="nsew"); self.cards.bind("<<TreeviewSelect>>",self.select_card)
    def _controls(self):
        self.kt.columnconfigure(1,weight=1); self.kt.rowconfigure(0,weight=1); form=ttk.LabelFrame(self.kt,text="Control RF",padding=8); form.grid(row=0,column=0,sticky="nw",padx=(0,8))
        self.kv={x:tk.StringVar() for x in ("id","user","description")}
        ttk.Label(form,text="ID").grid(row=0,column=0,sticky="w"); ttk.Entry(form,textvariable=self.kv["id"],width=30).grid(row=0,column=1,columnspan=2,sticky="w")
        ttk.Label(form,text="Usuario").grid(row=1,column=0,sticky="w"); self.control_user=ttk.Combobox(form,textvariable=self.kv["user"],state="readonly",width=28); self.control_user.grid(row=1,column=1,columnspan=2,sticky="w")
        ttk.Label(form,text="Descripcion").grid(row=2,column=0,sticky="w"); ttk.Entry(form,textvariable=self.kv["description"],width=30).grid(row=2,column=1,columnspan=2,sticky="w")
        ttk.Label(form,text="Codigo RF").grid(row=3,column=1,sticky="w",pady=(6,0)); ttk.Label(form,text="Salida").grid(row=3,column=2,sticky="w",pady=(6,0))
        self.kc=[tk.StringVar() for _ in range(CONTROL_BUTTONS)]; self.ko=[tk.StringVar(value=OUTPUT_NAMES[i]) for i in range(CONTROL_BUTTONS)]
        for i in range(CONTROL_BUTTONS):
            ttk.Label(form,text=f"Boton {i+1}").grid(row=4+i,column=0,sticky="w"); ttk.Entry(form,textvariable=self.kc[i],width=14).grid(row=4+i,column=1,sticky="w"); ttk.Combobox(form,textvariable=self.ko[i],values=(UNASSIGNED,)+OUTPUT_NAMES,state="readonly",width=12).grid(row=4+i,column=2,sticky="w")
        ttk.Label(form,text="ID vacio = control nuevo. Codigo RF en decimal.\nUn boton no registrado aparece en el simulador\ncomo 'Control desconocido' con su codigo.").grid(row=8,column=0,columnspan=3,sticky="w",pady=(6,0))
        bar=ttk.Frame(form); bar.grid(row=9,column=0,columnspan=3,pady=8)
        for text,command in (("Nuevo",self.new_control),("Guardar",self.save_control),("Eliminar",self.delete_control)): ttk.Button(bar,text=text,command=command).pack(side="left",padx=4)
        self.controls=self.tree(self.kt,("ID","Usuario","Descripcion")+tuple(f"Boton {i+1}" for i in range(CONTROL_BUTTONS)),width=110); self.controls.grid(row=0,column=1,sticky="nsew"); self.controls.bind("<<TreeviewSelect>>",self.select_control)
    def _permissions(self):
        self.pt.columnconfigure(1,weight=1); form=ttk.LabelFrame(self.pt,text="Permiso",padding=8); form.grid(row=0,column=0,sticky="nw",padx=(0,8)); self.pv={x:tk.StringVar(value="00:00" if x in ("start","end") else "") for x in ("id","name","start","end")}
        for row,(key,label) in enumerate((("id","ID 0-31"),("name","Nombre"),("start","Inicio"),("end","Fin"))): ttk.Label(form,text=label).grid(row=row,column=0,sticky="w");ttk.Entry(form,textvariable=self.pv[key]).grid(row=row,column=1)
        self.po=[tk.BooleanVar() for _ in OUTPUT_NAMES];self.pr=[tk.BooleanVar() for _ in READER_NAMES];self.pd=[tk.BooleanVar() for _ in DAY_NAMES]
        for row,(label,names,values) in enumerate((("Salidas",OUTPUT_NAMES,self.po),("Lectores",READER_NAMES,self.pr),("Dias",DAY_NAMES,self.pd)),4):
            ttk.Label(form,text=label).grid(row=row,column=0,sticky="nw");box=ttk.Frame(form);box.grid(row=row,column=1,sticky="w");[ttk.Checkbutton(box,text=n,variable=values[i]).grid(row=i//2,column=i%2,sticky="w") for i,n in enumerate(names)]
        ttk.Label(form,text="Los controles RF solo usan Salidas,\nDias y horario (no dependen del lector).").grid(row=7,column=0,columnspan=2,sticky="w",pady=(6,0))
        ttk.Button(form,text="Guardar",command=self.save_permission).grid(row=8,column=0,pady=8);ttk.Button(form,text="Eliminar",command=self.delete_permission).grid(row=8,column=1,pady=8)
        self.permissions=self.tree(self.pt,("ID","Nombre","Salidas","Lectores","Horario"));self.permissions.grid(row=0,column=1,sticky="nsew");self.permissions.bind("<<TreeviewSelect>>",self.select_permission)
    def _outputs(self):
        self.ot.columnconfigure(1,weight=1);form=ttk.LabelFrame(self.ot,text="Salida",padding=8);form.grid(row=0,column=0,sticky="nw",padx=(0,8));self.oid=tk.StringVar(value="0");self.od=tk.StringVar(value="3000");self.oe=tk.BooleanVar(value=True);self.orv=[tk.BooleanVar() for _ in READER_NAMES]
        ttk.Combobox(form,textvariable=self.oid,values=tuple(str(i) for i in range(len(OUTPUT_NAMES))),state="readonly",width=6).grid(row=0,column=1);ttk.Label(form,text="Salida").grid(row=0,column=0);ttk.Label(form,text="Duracion ms").grid(row=1,column=0);ttk.Entry(form,textvariable=self.od).grid(row=1,column=1);ttk.Checkbutton(form,text="Habilitada",variable=self.oe).grid(row=2,column=1)
        box=ttk.Frame(form);box.grid(row=3,column=1,sticky="w");[ttk.Checkbutton(box,text=n,variable=self.orv[i]).grid(row=i//2,column=i%2,sticky="w") for i,n in enumerate(READER_NAMES)];ttk.Button(form,text="Guardar",command=self.save_output).grid(row=4,column=1,pady=8)
        self.outputs=self.tree(self.ot,("Salida","Duracion","Lectores","Estado"));self.outputs.grid(row=0,column=1,sticky="nsew");self.outputs.bind("<<TreeviewSelect>>",self.select_output)
    def _logs(self):
        self.lt.columnconfigure(0,weight=1);self.lt.rowconfigure(0,weight=1);self.logs=self.tree(self.lt,("Fecha","Resultado","Origen","Usuario","Codigo","Dispositivo","Salida","Motivo"),width=130);self.logs.grid(row=0,column=0,sticky="nsew");ttk.Button(self.lt,text="Actualizar",command=self.refresh_logs).grid(row=1,column=0,sticky="e",pady=5);ttk.Button(self.lt,text="Borrar logs",command=lambda:(self.store.clear_logs(),self.refresh_logs())).grid(row=1,column=0,sticky="w",pady=5)
    def refill(self, tree, rows):
        tree.delete(*tree.get_children());[tree.insert("","end",iid=str(key),values=values) for key,values in rows]
    def refresh(self): self.refresh_permission_boxes();self.refresh_user_choices();self.refresh_users();self.refresh_cards();self.refresh_controls();self.refresh_permissions();self.refresh_outputs();self.refresh_logs()
    def refresh_permission_boxes(self):
        [x.destroy() for x in self.upf.winfo_children()];self.up=[]
        for i,p in enumerate(self.store.list_permissions()): v=tk.BooleanVar();ttk.Checkbutton(self.upf,text=f"{p['permission_id']}: {p['name']}",variable=v).grid(row=i,column=0,sticky="w");self.up.append((p['permission_id'],v))
    def refresh_user_choices(self):
        choices=[user_choice(r) for r in self.store.list_users()];self.card_user["values"]=choices;self.control_user["values"]=choices
    def refresh_users(self): self.refill(self.users,((r['user_id'],(r['user_id'],r['name'],r['department'],r['card_count'],r['control_count'],f"0x{r['permission_mask']:08X}")) for r in self.store.list_users()))
    def refresh_cards(self): self.refill(self.cards,((r['card_code'],(r['card_code'],user_choice(r),r['description'])) for r in self.store.list_cards()))
    def refresh_controls(self): self.refill(self.controls,((c['control_id'],(c['control_id'],user_choice(c),c['description'])+tuple(button_text(buttons.get(i)) for i in range(CONTROL_BUTTONS))) for c,buttons in self.store.list_controls()))
    def refresh_permissions(self): self.refill(self.permissions,((p['permission_id'],(p['permission_id'],p['name'],", ".join(n for i,n in enumerate(OUTPUT_NAMES) if p['output_mask']&(1<<i)),", ".join(n for i,n in enumerate(READER_NAMES) if p['reader_mask']&(1<<i)),f"{p['start_minute']//60:02}:{p['start_minute']%60:02}-{p['end_minute']//60:02}:{p['end_minute']%60:02}")) for p in self.store.list_permissions()))
    def refresh_outputs(self): self.refill(self.outputs,((o.output_id,(OUTPUT_NAMES[o.output_id],f"{o.duration_ms} ms",", ".join(n for i,n in enumerate(READER_NAMES) if o.reader_mask&(1<<i)),"Habilitada" if o.enabled else "Deshabilitada")) for o in self.store.list_outputs()))
    def refresh_logs(self): self.refill(self.logs,((r['log_id'],log_values(r)) for r in self.store.list_logs()))
    def save_user(self):
        try: self.store.save_user(int(self.uv['id'].get()),self.uv['name'].get(),self.uv['department'].get(),self.uv['address'].get(),[p for p,v in self.up if v.get()],self.uv['pin'].get());self.refresh()
        except (ValueError,sqlite3.IntegrityError) as e: messagebox.showerror("Usuario",str(e))
    def select_user(self,_=None):
        if not self.users.selection(): return
        u=self.store.get_user(int(self.users.selection()[0]));self.uv['id'].set(str(u['user_id']));self.uv['name'].set(u['name']);self.uv['department'].set(u['department']);self.uv['address'].set(u['address']);self.uv['pin'].set('');ps=self.store.user_permissions(u['user_id']);[v.set(p in ps) for p,v in self.up]
    def delete_user(self):
        if self.users.selection(): self.store.delete_user(int(self.users.selection()[0]));self.refresh()
    def save_card(self):
        try: self.store.save_card(parse_code(self.cv['code'].get(),"Codigo de tarjeta"),parse_user_choice(self.cv['user'].get()),self.cv['description'].get().strip());self.refresh_cards();self.refresh_users()
        except (ValueError,sqlite3.IntegrityError) as e: messagebox.showerror("Tarjeta",str(e))
    def select_card(self,_=None):
        if not self.cards.selection(): return
        c=self.store.get_card(int(self.cards.selection()[0]));self.cv['code'].set(str(c['card_code']));self.cv['user'].set(user_choice(c));self.cv['description'].set(c['description'])
    def delete_card(self):
        if self.cards.selection(): self.store.delete_card(int(self.cards.selection()[0]));self.refresh_cards();self.refresh_users()
    def new_control(self):
        [v.set("") for v in self.kv.values()];[v.set("") for v in self.kc];[v.set(OUTPUT_NAMES[i]) for i,v in enumerate(self.ko)]
        if self.controls.selection(): self.controls.selection_remove(*self.controls.selection())
    def save_control(self):
        try:
            control_id=int(self.kv['id'].get()) if self.kv['id'].get().strip() else None
            buttons=[(parse_code(code.get(),f"Codigo del boton {i+1}") if code.get().strip() else None,OUTPUT_NAMES.index(output.get()) if output.get() in OUTPUT_NAMES else None) for i,(code,output) in enumerate(zip(self.kc,self.ko))]
            self.kv['id'].set(str(self.store.save_control(control_id,parse_user_choice(self.kv['user'].get()),self.kv['description'].get().strip(),buttons)));self.refresh_controls();self.refresh_users()
        except (ValueError,sqlite3.IntegrityError) as e: messagebox.showerror("Control",str(e))
    def select_control(self,_=None):
        if not self.controls.selection(): return
        control_id=int(self.controls.selection()[0]);c=self.store.get_control(control_id);buttons=self.store.control_buttons(control_id)
        self.kv['id'].set(str(control_id));self.kv['user'].set(user_choice(c));self.kv['description'].set(c['description'])
        for i in range(CONTROL_BUTTONS):
            code,output=buttons.get(i,(None,i));self.kc[i].set(str(code) if code is not None else "");self.ko[i].set(OUTPUT_NAMES[output] if output is not None else UNASSIGNED)
    def delete_control(self):
        if self.controls.selection(): self.store.delete_control(int(self.controls.selection()[0]));self.new_control();self.refresh_controls();self.refresh_users()
    def save_permission(self):
        try: self.store.save_permission((int(self.pv['id'].get()),self.pv['name'].get(),mask(self.po),mask(self.pr),mask(self.pd),parse_time(self.pv['start'].get()),parse_time(self.pv['end'].get())));self.refresh()
        except (ValueError,sqlite3.IntegrityError) as e: messagebox.showerror("Permiso",str(e))
    def select_permission(self,_=None):
        if not self.permissions.selection():return
        p=next(x for x in self.store.list_permissions() if x['permission_id']==int(self.permissions.selection()[0]));self.pv['id'].set(p['permission_id']);self.pv['name'].set(p['name']);self.pv['start'].set(f"{p['start_minute']//60:02}:{p['start_minute']%60:02}");self.pv['end'].set(f"{p['end_minute']//60:02}:{p['end_minute']%60:02}");set_mask(self.po,p['output_mask']);set_mask(self.pr,p['reader_mask']);set_mask(self.pd,p['weekday_mask'])
    def delete_permission(self):
        if self.permissions.selection():self.store.delete_permission(int(self.permissions.selection()[0]));self.refresh()
    def save_output(self):
        try:self.store.save_output(OutputConfig(int(self.oid.get()),int(self.od.get()),mask(self.orv),self.oe.get()));self.refresh_outputs()
        except ValueError as e:messagebox.showerror("Salida",str(e))
    def select_output(self,_=None):
        if not self.outputs.selection():return
        o=next(x for x in self.store.list_outputs() if x.output_id==int(self.outputs.selection()[0]));self.oid.set(o.output_id);self.od.set(o.duration_ms);self.oe.set(o.enabled);set_mask(self.orv,o.reader_mask)
    def close(self): self.store.close();self.destroy()

if __name__ == '__main__': AdminApp().mainloop()
