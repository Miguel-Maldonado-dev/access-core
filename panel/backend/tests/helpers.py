from datetime import datetime

NOW = datetime(2026, 9, 29, 10, 0)  # martes


def add_holder(conn, name="Amadeo 1260", kind="domicilio", permission_ids=(0,), pin=None):
    cur = conn.execute("INSERT INTO holders(kind, name, pin) VALUES (?, ?, ?)", (kind, name, pin))
    holder_id = cur.lastrowid
    for permission_id in permission_ids:
        conn.execute(
            "INSERT INTO holder_permissions(holder_id, permission_id) VALUES (?, ?)",
            (holder_id, permission_id),
        )
    return holder_id


def add_card(conn, code, holder_id, description=""):
    conn.execute(
        "INSERT INTO cards(card_code, holder_id, description) VALUES (?, ?, ?)",
        (code, holder_id, description),
    )


def add_control(conn, holder_id, buttons, description="Control 1"):
    cur = conn.execute(
        "INSERT INTO controls(holder_id, description) VALUES (?, ?)",
        (holder_id, description),
    )
    control_id = cur.lastrowid
    for button, (rf_code, output_id) in enumerate(buttons):
        if rf_code is None:
            continue
        conn.execute(
            "INSERT INTO control_buttons(control_id, button, rf_code, output_id) VALUES (?, ?, ?, ?)",
            (control_id, button, rf_code, output_id),
        )
    return control_id


def set_permission(conn, permission_id, output_mask, card_reader_mask=15, pin_reader_mask=0,
                   weekday_mask=127, start_minute=0, end_minute=0, name="p", allow_rf=1):
    conn.execute(
        "INSERT INTO permissions(permission_id, name, output_mask, card_reader_mask,"
        " pin_reader_mask, weekday_mask, start_minute, end_minute, allow_rf)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(permission_id) DO UPDATE SET name=excluded.name,"
        " output_mask=excluded.output_mask, card_reader_mask=excluded.card_reader_mask,"
        " pin_reader_mask=excluded.pin_reader_mask, weekday_mask=excluded.weekday_mask,"
        " start_minute=excluded.start_minute, end_minute=excluded.end_minute,"
        " allow_rf=excluded.allow_rf",
        (permission_id, name, output_mask, card_reader_mask, pin_reader_mask, weekday_mask,
         start_minute, end_minute, allow_rf),
    )
