"""Lab kit scan app: server.

Runs locally for now. Everything the browser does offline is queued on the
device and sent here later as events. The server is the master copy: it checks
every event, stores it once (by event_id), and never edits or deletes events.

Run:   python3 server.py seed    (creates the test users, prints their passwords once)
       python3 server.py         (starts on http://127.0.0.1:5000)
"""
import csv
import io
import os
import re
import secrets
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone

from flask import Flask, Response, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("KIT_DB", os.path.join(BASE, "kits.db"))
SESSION_HOURS = 8          # absolute session length (one shift)
IDLE_MINUTES = 30          # logged out after this long without activity

app = Flask(__name__, static_folder=os.path.join(BASE, "static"), static_url_path="")
app.secret_key = os.environ.get("KIT_SECRET") or secrets.token_hex(32)
app.permanent_session_lifetime = timedelta(hours=SESSION_HOURS)
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")

# Dummy studies, loaded once. A study is one record: its code is what the label prints,
# and it owns its visit schedule, the kits each visit needs and its participants.
# Replace with the signed protocols later.
DEMO_STUDIES = [
    {"code": "TAK-360-2002", "title": "TAK-360 Phase 2 (dummy)", "phase": "Phase II", "sponsor": "Demo sponsor A",
     "pi": "Dr. Demo One", "status": "Active", "participants": ["SM", "JC", "AK"], "visits": [
         ("SCR", -28, "A,B"), ("Unscheduled", None, "B"), ("Day -2", -2, "C,D"),
         ("Day -1", -1, "D"), ("Day 1", 1, "E"), ("Day 1 At Discharge", 1, "F"),
         ("Day 14", 14, "G"), ("Day 27", 27, "H"), ("Day 28", 28, "I"),
         ("Day 35, Early Term", 35, "J")]},
    {"code": "ORX750-0201", "title": "ORX750 Pre-screening (dummy)", "phase": "Phase II", "sponsor": "Demo sponsor B",
     "pi": "Dr. Demo Two", "status": "Enrolling", "participants": ["MG", "LO"], "visits": [
         ("Pre-screening", 0, "HLA")]},
    {"code": "PROTO-A", "title": "Study A (dummy)", "phase": "Phase III", "sponsor": "Demo sponsor C",
     "pi": "Dr. Demo Three", "status": "Active", "participants": ["DB", "GL"], "visits": [
         ("Visit 1", 1, "J"), ("Visit 2", 14, "K"), ("Visit 3", 28, "J,L")]},
    {"code": "PROTO-B", "title": "Study B (dummy)", "phase": "Phase I", "sponsor": "Demo sponsor D",
     "pi": "Dr. Demo Four", "status": "Active", "participants": ["RH"], "visits": [
         ("Visit 1", 1, "M"), ("Visit 2", 14, "J"), ("Visit 3", 28, "N")]},
]
STUDY_STATUSES = ("Active", "Enrolling", "Closed")
PARTICIPANT_STATUSES = ("In Screening", "Enrolled", "Completed", "Withdrawn")
DEFAULT_SETTINGS = {
    "expiry_days": 30,      # alert this many days before a kit expires
    "low_stock_total": 5,   # alert at this many usable kits of a type, all stock
    "low_stock_study": 5,   # alert at this many usable kits of a type in a study
}
KIT_TYPE = re.compile(r"^[A-Z0-9][A-Z0-9-]{0,11}$")   # J on PPD labels, HLA on Syneos labels


def now_utc():
    return datetime.now(timezone.utc)


def iso_now():
    return now_utc().isoformat(timespec="seconds")


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def create_study_tables(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS studies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL COLLATE NOCASE,   -- as printed on the label
        title TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT '',
        sponsor TEXT NOT NULL DEFAULT '',
        pi TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Active'
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        study_id INTEGER NOT NULL REFERENCES studies(id),
        name TEXT NOT NULL COLLATE NOCASE,
        day INTEGER,                    -- schedule day; empty for unscheduled visits
        kit_types TEXT NOT NULL,        -- comma separated, e.g. "J,L"
        UNIQUE (study_id, name)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS low_stock_overrides (
        kit_type TEXT NOT NULL,
        study_id INTEGER NOT NULL DEFAULT 0,  -- 0 means all stock of the type
        threshold INTEGER NOT NULL,
        PRIMARY KEY (kit_type, study_id)
    )""")


def merge_protocols_into_studies(conn):
    """Each old protocol becomes one study and keeps its id, so kits stay allocated."""
    old_study = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM studies")}
    protocols = conn.execute("SELECT id, study_id, code, name FROM protocols").fetchall()
    visits = conn.execute("SELECT id, protocol_id, name, day, kit_types FROM visits").fetchall()
    overrides = conn.execute("SELECT kit_type, protocol_id, threshold FROM low_stock_overrides").fetchall()
    box_columns = [row[1] for row in conn.execute("PRAGMA table_info(boxes)")]
    conn.execute("ALTER TABLE boxes RENAME TO boxes_old")
    keep = [c for c in box_columns if c != "protocol_id"]
    conn.execute("""CREATE TABLE boxes (
        serial TEXT PRIMARY KEY, kit_type TEXT, product TEXT, lot TEXT, expiry TEXT,
        quantity INTEGER NOT NULL DEFAULT 1, remaining_quantity INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, used_for TEXT, received_by TEXT, received_at TEXT, updated_at TEXT,
        study_id INTEGER REFERENCES studies(id))""")
    names = ", ".join(keep)
    conn.execute(f"INSERT INTO boxes ({names}, study_id) SELECT {names}, protocol_id FROM boxes_old")
    for table in ("boxes_old", "low_stock_overrides", "visits", "protocols", "studies"):
        conn.execute(f"DROP TABLE {table}")
    create_study_tables(conn)
    for pid, study_id, code, name in protocols:
        conn.execute("INSERT INTO studies (id, code, title, sponsor) VALUES (?, ?, ?, ?)",
                     (pid, code, name, old_study.get(study_id, "")))
    conn.executemany("INSERT INTO visits (id, study_id, name, day, kit_types) VALUES (?, ?, ?, ?, ?)", visits)
    conn.executemany("INSERT INTO low_stock_overrides (kit_type, study_id, threshold) VALUES (?, ?, ?)", overrides)


def seed_demo_studies(conn):
    start = (date.today() - timedelta(days=7)).isoformat()
    for demo in DEMO_STUDIES:
        details = (demo["title"], demo["phase"], demo["sponsor"], demo["pi"], demo["status"], demo["code"])
        existing = conn.execute("SELECT id FROM studies WHERE code = ?", (demo["code"],)).fetchone()
        if existing:    # an old protocol record with the same code
            study_id = existing[0]
            conn.execute("UPDATE studies SET title = ?, phase = ?, sponsor = ?, pi = ?, status = ? WHERE code = ?", details)
        else:
            study_id = conn.execute("INSERT INTO studies (title, phase, sponsor, pi, status, code) VALUES (?, ?, ?, ?, ?, ?)",
                                    details).lastrowid
            conn.executemany("INSERT INTO visits (study_id, name, day, kit_types) VALUES (?, ?, ?, ?)",
                             [(study_id, name, day, kits) for name, day, kits in demo["visits"]])
        conn.executemany("INSERT INTO participants (study_id, initials, status, start_date) VALUES (?, ?, 'Enrolled', ?)",
                         [(study_id, initials, start) for initials in demo["participants"]])


def init_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            pw_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS boxes (
            serial TEXT PRIMARY KEY,
            kit_type TEXT,
            product TEXT,
            lot TEXT,
            expiry TEXT,
            quantity INTEGER NOT NULL DEFAULT 1,
            remaining_quantity INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,          -- in_stock | used | removed
            used_for TEXT,                  -- "initials | visit" when used
            received_by TEXT,
            received_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS events (
            event_id TEXT PRIMARY KEY,      -- set on the device, makes sync safe to repeat
            action TEXT NOT NULL,           -- receive | use | remove | signoff
            serial TEXT,
            participant TEXT,
            visit TEXT,
            reason TEXT,
            payload TEXT,
            user_id TEXT NOT NULL,
            device TEXT,
            device_time TEXT,
            server_time TEXT NOT NULL,
            result TEXT NOT NULL,           -- accepted | rejected
            message TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alert_acks (
            user_id TEXT NOT NULL,
            alert_key TEXT NOT NULL,
            ack_date TEXT NOT NULL,         -- hidden for this user on this date only
            PRIMARY KEY (user_id, alert_key, ack_date)
        );
        """
    )
    # Each server worker runs this at start-up, so only one may upgrade at a time.
    conn.execute("BEGIN IMMEDIATE")
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    columns = {row[1] for row in conn.execute("PRAGMA table_info(boxes)")}
    if "quantity" not in columns:
        conn.execute("ALTER TABLE boxes ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1")
    if "remaining_quantity" not in columns:
        conn.execute("ALTER TABLE boxes ADD COLUMN remaining_quantity INTEGER NOT NULL DEFAULT 1")
    new_database = "studies" not in tables
    if "protocols" in tables:
        merge_protocols_into_studies(conn)
        new_database = True     # the old records were all dummy data; add the demo schedule
    else:
        create_study_tables(conn)
        if "study_id" not in columns:
            conn.execute("ALTER TABLE boxes ADD COLUMN study_id INTEGER REFERENCES studies(id)")
    conn.execute("""CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        study_id INTEGER NOT NULL REFERENCES studies(id),
        initials TEXT NOT NULL COLLATE NOCASE,
        status TEXT NOT NULL,
        start_date TEXT NOT NULL,       -- visit dates are this plus the schedule day
        UNIQUE (study_id, initials)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS visit_signoffs (
        participant_id INTEGER NOT NULL REFERENCES participants(id),
        visit TEXT NOT NULL,
        signed_by TEXT NOT NULL,
        signed_at TEXT NOT NULL,
        PRIMARY KEY (participant_id, visit)
    )""")
    conn.execute("UPDATE settings SET key = 'low_stock_study' WHERE key = 'low_stock_protocol'")
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))
    if new_database:
        seed_demo_studies(conn)
    conn.commit()
    conn.close()


init_db()


# ---------- auth ----------

def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    last = session.get("last_seen")
    if last and now_utc() - datetime.fromisoformat(last) > timedelta(minutes=IDLE_MINUTES):
        session.clear()
        return None
    session["last_seen"] = iso_now()
    row = db().execute("SELECT id, email, name FROM users WHERE id = ?", (uid,)).fetchone()
    return dict(row) if row else None


def require_user():
    user = current_user()
    if not user:
        return None, (jsonify(error="Sign in again"), 401)
    return user, None


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    pw = str(data.get("password", ""))
    row = db().execute("SELECT id, email, name, pw_hash FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not check_password_hash(row["pw_hash"], pw):
        return jsonify(error="Wrong email or password"), 401
    session.clear()
    session.permanent = True
    session["uid"] = row["id"]
    session["last_seen"] = iso_now()
    return jsonify(user={"id": row["id"], "email": row["email"], "name": row["name"]},
                   shift_hours=SESSION_HOURS, idle_minutes=IDLE_MINUTES)


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def me():
    user, err = require_user()
    if err:
        return err
    return jsonify(user=user, today=date.today().isoformat())


# ---------- data for the screens ----------

def participant_code(participant_id):
    return f"PRT-{1000 + participant_id}"


def config_payload():
    """Studies, with everything that belongs to them, and alert settings. Kept on the device for offline use."""
    cur = db()
    visits, signed, participants = {}, {}, {}
    for v in cur.execute("SELECT * FROM visits ORDER BY day IS NULL, day, id"):
        visits.setdefault(v["study_id"], []).append(
            {"id": v["id"], "name": v["name"], "day": v["day"], "kit_types": v["kit_types"].split(",")})
    for row in cur.execute("SELECT participant_id, visit FROM visit_signoffs"):
        signed.setdefault(row["participant_id"], []).append(row["visit"])
    for p in cur.execute("SELECT * FROM participants ORDER BY id"):
        participants.setdefault(p["study_id"], []).append(
            {"id": p["id"], "code": participant_code(p["id"]), "initials": p["initials"], "status": p["status"],
             "start_date": p["start_date"], "signed": signed.get(p["id"], [])})
    studies = [dict(s, visits=visits.get(s["id"], []), participants=participants.get(s["id"], []))
               for s in cur.execute("SELECT * FROM studies ORDER BY code")]
    settings = {r["key"]: r["value"] for r in cur.execute("SELECT key, value FROM settings")}
    overrides = [dict(r) for r in cur.execute("SELECT * FROM low_stock_overrides ORDER BY kit_type, study_id")]
    return {"studies": studies, "settings": settings, "overrides": overrides,
            "study_statuses": STUDY_STATUSES, "participant_statuses": PARTICIPANT_STATUSES}


@app.get("/api/state")
def state():
    """Snapshot the device keeps for offline use."""
    user, err = require_user()
    if err:
        return err
    rows = db().execute("SELECT * FROM boxes ORDER BY received_at DESC").fetchall()
    # A few days back, because the device and the server can be on different dates.
    since = (date.today() - timedelta(days=3)).isoformat()
    acks = db().execute("SELECT alert_key, ack_date FROM alert_acks WHERE user_id = ? AND ack_date >= ?",
                        (user["id"], since)).fetchall()
    return jsonify(boxes=[dict(r) for r in rows], config=config_payload(),
                   acks=[dict(a) for a in acks],
                   today=date.today().isoformat(), server_time=iso_now())


@app.get("/api/audit")
def audit():
    user, err = require_user()
    if err:
        return err
    rows = db().execute(
        """SELECT e.server_time, e.action, e.serial, e.participant, e.visit, e.reason,
                  e.result, e.message, e.device, u.email AS user
           FROM events e JOIN users u ON u.id = e.user_id
           ORDER BY e.server_time DESC LIMIT 500"""
    ).fetchall()
    return jsonify(events=[dict(r) for r in rows])


@app.get("/api/export.csv")
def export_csv():
    user, err = require_user()
    if err:
        return err
    rows = db().execute(
        """SELECT b.*, s.code AS study FROM boxes b
           LEFT JOIN studies s ON s.id = b.study_id
           ORDER BY b.received_at"""
    ).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Kit serial", "Kit type", "Expiry", "Study", "Lot", "Product",
                "Status", "Used for", "Received by", "Received at", "Last updated"])
    for r in rows:
        w.writerow([r["serial"], r["kit_type"], r["expiry"], r["study"] or "Unallocated", r["lot"], r["product"], r["status"],
                    r["used_for"], r["received_by"], r["received_at"], r["updated_at"]])
    name = f"lab-kits-{date.today().isoformat()}.csv"
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------- sync: the one place data changes ----------

def find_study(value):
    """Returns (study row or None, error). An empty value means unallocated."""
    if value in (None, ""):
        return None, None
    row = db().execute("SELECT * FROM studies WHERE id = ?", (str(value),)).fetchone()
    return (row, None) if row else (None, "That study does not exist")


def study_details(ev):
    """Returns (values, error) for the fields of a new or edited study."""
    code = str(ev.get("code") or "").strip()
    title = str(ev.get("title") or "").strip() or code
    status = str(ev.get("status") or "Active")
    if not code:
        return None, "Enter the study ID, as printed on the label"
    if status not in STUDY_STATUSES:
        return None, "Unknown study status"
    return {"code": code, "title": title, "status": status, "phase": str(ev.get("phase") or "").strip(),
            "sponsor": str(ev.get("sponsor") or "").strip(), "pi": str(ev.get("pi") or "").strip()}, None


def whole_number(value):
    """Returns a non-negative whole number, or None if the value is not one."""
    text = str(value).strip()
    return int(text) if text.isdigit() and len(text) <= 6 else None


def apply_admin_event(ev):
    """Settings and study set-up. Returns (ok, message), or None for other actions."""
    action = ev.get("action")
    cur = db()

    if action == "set_settings":
        values = ev.get("settings")
        if not isinstance(values, dict) or not values or set(values) - set(DEFAULT_SETTINGS):
            return False, "Unknown settings"
        numbers = {key: whole_number(value) for key, value in values.items()}
        if None in numbers.values():
            return False, "Alert settings must be whole numbers"
        for key, value in numbers.items():
            cur.execute("UPDATE settings SET value = ? WHERE key = ?", (value, key))
        summary = ", ".join(f"{key}={value}" for key, value in numbers.items())
        return True, f"Alert settings changed: {summary}"

    if action == "set_override":
        kit_type = str(ev.get("kit_type") or "").strip().upper()
        if not KIT_TYPE.match(kit_type):
            return False, "Kit type must be letters or digits, such as J or HLA"
        study, error = find_study(ev.get("study_id"))
        if error:
            return False, error
        scope = study["code"] if study else "all stock"
        study_id = study["id"] if study else 0
        if str(ev.get("threshold") if ev.get("threshold") is not None else "").strip() == "":
            cur.execute("DELETE FROM low_stock_overrides WHERE kit_type = ? AND study_id = ?",
                        (kit_type, study_id))
            return True, f"Removed the low stock override for Kit {kit_type}, {scope}"
        threshold = whole_number(ev.get("threshold"))
        if threshold is None:
            return False, "The alert quantity must be a whole number"
        cur.execute("INSERT OR REPLACE INTO low_stock_overrides (kit_type, study_id, threshold) VALUES (?, ?, ?)",
                    (kit_type, study_id, threshold))
        return True, f"Kit {kit_type}, {scope}: alert at {threshold} left"

    if action == "add_study":
        values, error = study_details(ev)
        if error:
            return False, error
        if cur.execute("SELECT 1 FROM studies WHERE code = ?", (values["code"],)).fetchone():
            return False, f"Study {values['code']} already exists"
        cur.execute("""INSERT INTO studies (code, title, phase, sponsor, pi, status)
                       VALUES (:code, :title, :phase, :sponsor, :pi, :status)""", values)
        return True, f"Added study {values['code']}"

    if action == "update_study":
        study, error = find_study(ev.get("study_id"))
        if error or not study:
            return False, error or "Choose the study"
        values, error = study_details(ev)
        if error:
            return False, error
        if cur.execute("SELECT 1 FROM studies WHERE code = ? AND id != ?", (values["code"], study["id"])).fetchone():
            return False, f"Study {values['code']} already exists"
        cur.execute("""UPDATE studies SET code = :code, title = :title, phase = :phase, sponsor = :sponsor,
                       pi = :pi, status = :status WHERE id = :id""", dict(values, id=study["id"]))
        return True, f"Updated study {values['code']}"

    if action == "add_visit":
        study, error = find_study(ev.get("study_id"))
        if error or not study:
            return False, error or "Choose the study"
        name = str(ev.get("name") or "").strip()
        if not name:
            return False, "Enter the visit name"
        raw_day = str(ev.get("day") if ev.get("day") is not None else "").strip()
        if raw_day and not re.match(r"^-?\d{1,5}$", raw_day):
            return False, "The visit day must be a whole number, such as 14 or -2"
        kits = [k.upper() for k in re.split(r"[\s,]+", str(ev.get("kit_types") or "")) if k]
        if not kits or not all(KIT_TYPE.match(k) for k in kits):
            return False, "List the kit types this visit needs, such as J, K"
        if cur.execute("SELECT 1 FROM visits WHERE study_id = ? AND name = ?", (study["id"], name)).fetchone():
            return False, f"{study['code']} already has a visit called {name}"
        cur.execute("INSERT INTO visits (study_id, name, day, kit_types) VALUES (?, ?, ?, ?)",
                    (study["id"], name, int(raw_day) if raw_day else None, ",".join(dict.fromkeys(kits))))
        return True, f"Added {name} to {study['code']}"

    if action == "remove_visit":
        visit = cur.execute("""SELECT v.id, v.name, v.study_id, s.code FROM visits v JOIN studies s ON s.id = v.study_id
                               WHERE v.id = ?""", (str(ev.get("visit_id")),)).fetchone()
        if not visit:
            return False, "That visit does not exist"
        signed = cur.execute("""SELECT 1 FROM visit_signoffs o JOIN participants p ON p.id = o.participant_id
                                WHERE p.study_id = ? AND o.visit = ?""", (visit["study_id"], visit["name"])).fetchone()
        if signed:
            return False, f"{visit['name']} has signed-off participants, so it cannot be removed"
        cur.execute("DELETE FROM visits WHERE id = ?", (visit["id"],))
        return True, f"Removed {visit['name']} from {visit['code']}"

    if action == "add_participant":
        study, error = find_study(ev.get("study_id"))
        if error or not study:
            return False, error or "Choose the study"
        initials = str(ev.get("initials") or "").strip().upper()
        status = str(ev.get("status") or "In Screening")
        start = str(ev.get("start_date") or date.today().isoformat())
        if not re.match(r"^[A-Z-]{1,4}$", initials):
            return False, "Enter the participant initials, up to 4 letters"
        if status not in PARTICIPANT_STATUSES:
            return False, "Unknown participant status"
        try:
            date.fromisoformat(start)
        except ValueError:
            return False, "The start date is not valid"
        if cur.execute("SELECT 1 FROM participants WHERE study_id = ? AND initials = ?", (study["id"], initials)).fetchone():
            return False, f"{study['code']} already has a participant {initials}"
        cur.execute("INSERT INTO participants (study_id, initials, status, start_date) VALUES (?, ?, ?, ?)",
                    (study["id"], initials, status, start))
        return True, f"Added {initials} to {study['code']}"

    if action == "update_participant":
        participant = cur.execute("SELECT * FROM participants WHERE id = ?", (str(ev.get("participant_id")),)).fetchone()
        status = str(ev.get("status") or "")
        if not participant:
            return False, "That participant does not exist"
        if status not in PARTICIPANT_STATUSES:
            return False, "Unknown participant status"
        cur.execute("UPDATE participants SET status = ? WHERE id = ?", (status, participant["id"]))
        return True, f"{participant['initials']} is now {status}"

    return None


def apply_event(ev, user):
    """Check one event against the rules and apply it. Returns (ok, message)."""
    action = ev.get("action")
    serial = str(ev.get("serial") or "").strip()
    cur = db()
    today = date.today().isoformat()

    if action == "receive":
        if not serial:
            return False, "Scan the kit serial first"
        if cur.execute("SELECT 1 FROM boxes WHERE serial = ?", (serial,)).fetchone():
            return False, f"{serial} is already received"
        kit_type = str(ev.get("kit_type") or "").strip().upper()
        if not KIT_TYPE.match(kit_type):
            return False, "Kit type must be letters or digits, such as J or HLA"
        lot = str(ev.get("lot") or "").strip()
        study, error = find_study(ev.get("study_id"))
        if error:
            return False, error
        expiry = str(ev.get("expiry") or "")
        try:
            parsed_expiry = date.fromisoformat(expiry)
        except ValueError:
            return False, "Expiry must be a valid date in YYYY-MM-DD format"
        if parsed_expiry.isoformat() != expiry:
            return False, "Expiry must be a valid date in YYYY-MM-DD format"
        if expiry < today:
            return False, f"{serial} is already expired ({expiry}); record it as removed"
        cur.execute(
            """INSERT INTO boxes (serial, kit_type, product, lot, expiry, quantity,
                                  remaining_quantity, status, study_id,
                                  received_by, received_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, 1, 'in_stock', ?, ?, ?, ?)""",
            (serial, kit_type, ev.get("product", ""), lot, expiry, study["id"] if study else None,
             user["email"], ev.get("device_time") or iso_now(), iso_now()),
        )
        return True, f"Received {serial} into {study['code'] if study else 'unallocated stock'}"

    if action == "allocate":
        box = cur.execute("SELECT * FROM boxes WHERE serial = ?", (serial,)).fetchone()
        if not box:
            return False, f"{serial} is not in stock"
        if box["status"] != "in_stock":
            return False, f"{serial} is {box['status']} ({box['used_for'] or 'no visit'})"
        study, error = find_study(ev.get("study_id"))
        if error:
            return False, error
        cur.execute("UPDATE boxes SET study_id = ?, updated_at = ? WHERE serial = ?",
                    (study["id"] if study else None, iso_now(), serial))
        return True, f"{serial} moved to {study['code'] if study else 'unallocated stock'}"

    if action == "use":
        box = cur.execute("SELECT * FROM boxes WHERE serial = ?", (serial,)).fetchone()
        if not box:
            return False, f"{serial} is not in stock. Receive it first"
        if box["status"] != "in_stock":
            return False, f"{serial} is {box['status']} ({box['used_for'] or 'no visit'})"
        if box["expiry"] and box["expiry"] < today:
            return False, f"{serial} expired on {box['expiry']}. Record it as removed"
        visit = str(ev.get("visit") or "")
        reason = str(ev.get("reason") or "").strip()
        if box["study_id"] is None:
            return False, f"{serial} is unallocated. Allocate it to a study first"
        allowed = [v["name"] for v in cur.execute("SELECT name, kit_types FROM visits WHERE study_id = ?",
                                                  (box["study_id"],))
                   if box["kit_type"] in v["kit_types"].split(",")]
        if visit not in allowed and not reason:
            return False, f"Kit {box['kit_type']} is not planned for {visit}. Give a reason to use it"
        person = cur.execute("SELECT * FROM participants WHERE id = ? AND study_id = ?",
                             (str(ev.get("participant_id")), box["study_id"])).fetchone()
        if not person:
            return False, "Choose a participant in this kit's study"
        participant = person["initials"]
        cur.execute(
            """UPDATE boxes SET status = 'used', remaining_quantity = 0, used_for = ?,
                               updated_at = ? WHERE serial = ?""",
            (f"{participant} | {visit}", iso_now(), serial),
        )
        return True, f"Used {serial} for {participant}, {visit}"

    if action == "remove":
        box = cur.execute("SELECT * FROM boxes WHERE serial = ?", (serial,)).fetchone()
        if not box:
            return False, f"{serial} is not in stock"
        if box["status"] != "in_stock":
            return False, f"{serial} is {box['status']} ({box['used_for'] or 'no visit'})"
        reason = str(ev.get("reason") or "").strip()
        if not reason:
            return False, "Give a reason for removing this kit"
        cur.execute(
            "UPDATE boxes SET status = 'removed', used_for = ?, updated_at = ? WHERE serial = ?",
            (f"removed: {reason}", iso_now(), serial),
        )
        return True, f"Removed {serial}"

    if action == "signoff":
        person = cur.execute("SELECT * FROM participants WHERE id = ?", (str(ev.get("participant_id")),)).fetchone()
        visit = str(ev.get("visit") or "")
        if not person or not visit:
            return False, "Participant and visit are needed to sign off"
        if not cur.execute("SELECT 1 FROM visits WHERE study_id = ? AND name = ?", (person["study_id"], visit)).fetchone():
            return False, f"{visit} is not in this participant's study schedule"
        if cur.execute("SELECT 1 FROM visit_signoffs WHERE participant_id = ? AND visit = ?", (person["id"], visit)).fetchone():
            return False, f"{person['initials']}, {visit} is already signed off"
        cur.execute("INSERT INTO visit_signoffs (participant_id, visit, signed_by, signed_at) VALUES (?, ?, ?, ?)",
                    (person["id"], visit, user["email"], iso_now()))
        return True, f"Signed off {person['initials']}, {visit}"

    if action == "ack_alert":
        key = str(ev.get("alert_key") or "").strip()
        ack_date = str(ev.get("ack_date") or "")
        if not key or not re.match(r"^\d{4}-\d{2}-\d{2}$", ack_date):
            return False, "Alert acknowledgement is incomplete"
        cur.execute("INSERT OR IGNORE INTO alert_acks (user_id, alert_key, ack_date) VALUES (?, ?, ?)",
                    (user["id"], key, ack_date))
        return True, f"Acknowledged: {ev.get('reason') or key}"

    admin = apply_admin_event(ev)
    if admin:
        return admin
    return False, f"Unknown action {action}"


@app.post("/api/sync")
def sync():
    """Body: {"events": [...]}. Each event has event_id, action and details.
    Already-stored event_ids return their old result, so repeated sends are safe."""
    user, err = require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    events = body.get("events") if isinstance(body, dict) else None
    if not isinstance(events, list):
        return jsonify(error="events must be a list"), 400
    results = []
    for ev in events:
        if not isinstance(ev, dict):
            results.append({"event_id": None, "result": "rejected", "message": "Each event must be an object"})
            continue
        event_id = str(ev.get("event_id") or "")
        if not event_id:
            results.append({"event_id": None, "result": "rejected", "message": "Missing event id"})
            continue
        prior = db().execute("SELECT result, message FROM events WHERE event_id = ?", (event_id,)).fetchone()
        if prior:
            results.append({"event_id": event_id, "result": prior["result"], "message": prior["message"]})
            continue
        ok, message = apply_event(ev, user)
        result = "accepted" if ok else "rejected"
        db().execute(
            """INSERT INTO events (event_id, action, serial, participant, visit, reason, payload,
                                   user_id, device, device_time, server_time, result, message)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (event_id, ev.get("action"), str(ev.get("serial") or ""), str(ev.get("participant") or ""),
             str(ev.get("visit") or ""), str(ev.get("reason") or ""),
             str(ev.get("product") or ev.get("alert_key") or ""),
             user["id"], str(ev.get("device") or "")[:120], str(ev.get("device_time") or ""),
             iso_now(), result, message),
        )
        db().commit()
        results.append({"event_id": event_id, "result": result, "message": message})
    return jsonify(results=results)


# ---------- pages ----------

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/<path:name>")
def static_files(name):
    return send_from_directory(app.static_folder, name)


def seed():
    """Create the test users. Prints each password once."""
    conn = sqlite3.connect(DB_PATH)
    users = [("tester1@lab.test", "Tester One"), ("tester2@lab.test", "Tester Two")]
    print("Test logins (save these now, they are not shown again):")
    for email, name in users:
        pw = secrets.token_urlsafe(9)
        existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            # keep the same id so the audit trail still points at the right person
            conn.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (generate_password_hash(pw), existing[0]))
        else:
            conn.execute(
                "INSERT INTO users (id, email, name, pw_hash) VALUES (?, ?, ?, ?)",
                (secrets.token_hex(8), email, name, generate_password_hash(pw)),
            )
        print(f"  {email}  {pw}")
    conn.commit()
    conn.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "seed":
        seed()
    else:
        app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
