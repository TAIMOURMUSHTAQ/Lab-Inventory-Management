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

# Demo protocol: each kit type and the visits it is used for. Replace with the
# signed protocol later. Quantities default to one until the signed protocol
# supplies a different deduction for a kit type and visit.
PROTOCOL = {
    "A": ["SCR"], "B": ["SCR", "Unscheduled"], "C": ["Day -2"],
    "D": ["Day -2", "Day -1"], "E": ["Day 1"], "F": ["Day 1 At Discharge"],
    "G": ["Day 14"], "H": ["Day 27"], "I": ["Day 28"], "J": ["Day 35, Early Term"],
}
PROTOCOL_QUANTITIES = {kit: {visit: 1 for visit in visits} for kit, visits in PROTOCOL.items()}


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


def init_db():
    conn = sqlite3.connect(DB_PATH)
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
        """
    )
    columns = {row[1] for row in conn.execute("PRAGMA table_info(boxes)")}
    if "quantity" not in columns:
        conn.execute("ALTER TABLE boxes ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1")
    if "remaining_quantity" not in columns:
        conn.execute("ALTER TABLE boxes ADD COLUMN remaining_quantity INTEGER NOT NULL DEFAULT 1")
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
    return jsonify(user=user, protocol=PROTOCOL, protocol_quantities=PROTOCOL_QUANTITIES,
                   today=date.today().isoformat())


# ---------- data for the screens ----------

@app.get("/api/state")
def state():
    """Snapshot the device keeps for offline use."""
    user, err = require_user()
    if err:
        return err
    rows = db().execute("SELECT * FROM boxes ORDER BY received_at DESC").fetchall()
    return jsonify(boxes=[dict(r) for r in rows], protocol=PROTOCOL,
                   protocol_quantities=PROTOCOL_QUANTITIES,
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
    rows = db().execute("SELECT * FROM boxes ORDER BY received_at").fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Kit serial", "Kit type", "Product", "Lot", "Expiry", "Quantity",
                "Remaining", "Status", "Used for", "Received by", "Received at", "Last updated"])
    for r in rows:
        w.writerow([r["serial"], r["kit_type"], r["product"], r["lot"], r["expiry"],
                    r["quantity"], r["remaining_quantity"], r["status"], r["used_for"],
                    r["received_by"], r["received_at"], r["updated_at"]])
    name = f"lab-kits-{date.today().isoformat()}.csv"
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------- sync: the one place data changes ----------

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
        if kit_type not in PROTOCOL:
            return False, "Kit type must be one of A through J"
        lot = str(ev.get("lot") or "").strip()
        if not lot:
            return False, "Lot is required"
        expiry = str(ev.get("expiry") or "")
        try:
            parsed_expiry = date.fromisoformat(expiry)
        except ValueError:
            return False, "Expiry must be a valid date in YYYY-MM-DD format"
        if parsed_expiry.isoformat() != expiry:
            return False, "Expiry must be a valid date in YYYY-MM-DD format"
        if expiry < today:
            return False, f"{serial} is already expired ({expiry}); record it as removed"
        try:
            quantity = int(ev.get("quantity", 1))
        except (TypeError, ValueError):
            return False, "Quantity must be a whole number"
        if quantity < 1:
            return False, "Quantity must be at least 1"
        cur.execute(
            """INSERT INTO boxes (serial, kit_type, product, lot, expiry, quantity,
                                  remaining_quantity, status,
                                  received_by, received_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, ?)""",
            (serial, kit_type, ev.get("product", ""), lot, expiry, quantity, quantity,
             user["email"], ev.get("device_time") or iso_now(), iso_now()),
        )
        return True, f"Received {serial}"

    if action == "use":
        box = cur.execute("SELECT * FROM boxes WHERE serial = ?", (serial,)).fetchone()
        if not box:
            return False, f"{serial} is not in stock. Receive it first"
        if box["status"] != "in_stock":
            return False, f"{serial} is {box['status']} ({box['used_for'] or 'no visit'})"
        if box["expiry"] and box["expiry"] < today:
            return False, f"{serial} expired on {box['expiry']}. Record it as removed"
        visit = str(ev.get("visit") or "")
        participant = str(ev.get("participant") or "").strip().upper()
        reason = str(ev.get("reason") or "").strip()
        allowed = PROTOCOL.get(box["kit_type"], [])
        try:
            amount = int(ev.get("amount") or PROTOCOL_QUANTITIES.get(box["kit_type"], {}).get(visit, 1))
        except (TypeError, ValueError):
            return False, "Deduction amount must be a whole number"
        if amount < 1:
            return False, "Deduction amount must be at least 1"
        if amount > box["remaining_quantity"]:
            return False, f"{serial} has only {box['remaining_quantity']} unit(s) remaining"
        if visit not in allowed and not reason:
            return False, f"Kit {box['kit_type']} is not planned for {visit}. Give a reason to use it"
        if not participant:
            return False, "Enter the participant initials"
        remaining = box["remaining_quantity"] - amount
        status = "used" if remaining == 0 else "in_stock"
        cur.execute(
            """UPDATE boxes SET status = ?, remaining_quantity = ?, used_for = ?,
                               updated_at = ? WHERE serial = ?""",
            (status, remaining, f"{participant} | {visit} (-{amount})", iso_now(), serial),
        )
        return True, f"Used {amount} unit(s) from {serial} for {participant}, {visit}"

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
        participant = str(ev.get("participant") or "").strip().upper()
        visit = str(ev.get("visit") or "")
        if not participant or not visit:
            return False, "Participant and visit are needed to sign off"
        return True, f"Signed off {participant}, {visit}"

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
             str(ev.get("visit") or ""), str(ev.get("reason") or ""), str(ev.get("product") or ""),
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
