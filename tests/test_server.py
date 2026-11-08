"""Server rules for studies, allocation, single-kit stock, alert acknowledgements and settings.

Run:   python3 -m unittest discover tests
"""
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid
from datetime import date, timedelta

DB_DIR = tempfile.mkdtemp()
os.environ["KIT_DB"] = os.path.join(DB_DIR, "test.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

FUTURE = (date.today() + timedelta(days=200)).isoformat()
counter = iter(range(1, 100000))


def new_serial():
    return f"S{next(counter):06d}"


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with server.app.app_context():
            server.db().execute(
                "INSERT INTO users (id, email, name, pw_hash) VALUES ('u1', 't@lab.test', 'T', ?)",
                (generate_password_hash("pw"),))
            server.db().commit()

    def setUp(self):
        self.client = server.app.test_client()
        self.assertEqual(self.client.post("/api/login", json={"email": "t@lab.test", "password": "pw"}).status_code, 200)

    def send(self, **event):
        event.setdefault("event_id", uuid.uuid4().hex)
        return self.client.post("/api/sync", json={"events": [event]}).get_json()["results"][0]

    def accepted(self, **event):
        res = self.send(**event)
        self.assertEqual(res["result"], "accepted", res["message"])
        return res

    def rejected(self, **event):
        res = self.send(**event)
        self.assertEqual(res["result"], "rejected", res["message"])
        return res

    def state(self):
        return self.client.get("/api/state").get_json()

    def study(self, code):
        for s in self.state()["config"]["studies"]:
            if s["code"] == code:
                return s
        self.fail(f"no study {code}")

    def person(self, code, initials):
        return next(p for p in self.study(code)["participants"] if p["initials"] == initials)

    def box(self, serial):
        return next(b for b in self.state()["boxes"] if b["serial"] == serial)

    def test_a_study_holds_its_schedule_and_participants(self):
        study = self.study("PROTO-A")
        visit = next(v for v in study["visits"] if v["name"] == "Visit 2")
        self.assertEqual(visit["kit_types"], ["K"])
        self.assertEqual([p["initials"] for p in study["participants"]], ["DB", "GL"])
        self.assertTrue(study["participants"][0]["code"].startswith("PRT-"))
        self.assertEqual(self.state()["config"]["settings"]["expiry_days"], 30)

    def test_receive_accepts_named_kit_type_without_a_lot_as_one_kit(self):
        serial = new_serial()
        self.accepted(action="receive", serial=serial, kit_type="hla", expiry=FUTURE, quantity=9)
        box = self.box(serial)
        self.assertEqual((box["kit_type"], box["quantity"], box["study_id"], box["lot"]), ("HLA", 1, None, ""))

    def test_receive_rejects_unknown_study_and_bad_kit_type(self):
        self.rejected(action="receive", serial=new_serial(), kit_type="J", expiry=FUTURE, study_id=9999)
        self.rejected(action="receive", serial=new_serial(), kit_type="NOT A KIT", expiry=FUTURE)

    def test_allocate_moves_stock_and_back_to_unallocated(self):
        serial = new_serial()
        sid = self.study("PROTO-A")["id"]
        self.accepted(action="receive", serial=serial, kit_type="J", expiry=FUTURE)
        self.accepted(action="allocate", serial=serial, study_id=sid)
        self.assertEqual(self.box(serial)["study_id"], sid)
        self.accepted(action="allocate", serial=serial, study_id=None)
        self.assertIsNone(self.box(serial)["study_id"])

    def test_use_needs_allocation_a_participant_of_the_study_and_a_planned_visit(self):
        serial = new_serial()
        sid = self.study("PROTO-A")["id"]
        person = self.person("PROTO-A", "DB")["id"]
        outsider = self.person("PROTO-B", "RH")["id"]
        self.accepted(action="receive", serial=serial, kit_type="J", expiry=FUTURE)
        self.rejected(action="use", serial=serial, participant_id=person, visit="Visit 1")
        self.accepted(action="allocate", serial=serial, study_id=sid)
        self.rejected(action="use", serial=serial, participant_id=person, visit="Visit 2")
        self.rejected(action="use", serial=serial, participant_id=outsider, visit="Visit 1")
        self.rejected(action="use", serial=serial, visit="Visit 1")
        self.accepted(action="use", serial=serial, participant_id=person, visit="Visit 1")
        box = self.box(serial)
        self.assertEqual((box["status"], box["used_for"]), ("used", "DB | Visit 1"))
        self.rejected(action="allocate", serial=serial, study_id=None)

    def test_unplanned_visit_is_allowed_with_a_reason(self):
        serial = new_serial()
        self.accepted(action="receive", serial=serial, kit_type="J", expiry=FUTURE, study_id=self.study("PROTO-A")["id"])
        self.accepted(action="use", serial=serial, participant_id=self.person("PROTO-A", "DB")["id"],
                      visit="Visit 2", reason="Replacement")

    def test_signoff_is_recorded_on_the_participant_once(self):
        pid = self.person("TAK-360-2002", "SM")["id"]
        self.rejected(action="signoff", participant_id=pid, visit="Not a visit")
        self.accepted(action="signoff", participant_id=pid, visit="SCR")
        self.rejected(action="signoff", participant_id=pid, visit="SCR")
        self.assertEqual(self.person("TAK-360-2002", "SM")["signed"], ["SCR"])

    def test_signed_visit_cannot_be_removed(self):
        study = self.study("TAK-360-2002")
        pid = self.person("TAK-360-2002", "JC")["id"]
        self.accepted(action="signoff", participant_id=pid, visit="Day 14")
        visit = next(v for v in study["visits"] if v["name"] == "Day 14")
        self.rejected(action="remove_visit", visit_id=visit["id"])

    def test_acknowledgement_is_per_user_and_date_and_safe_to_repeat(self):
        event_id = uuid.uuid4().hex
        today = date.today().isoformat()
        for _ in range(2):
            self.accepted(event_id=event_id, action="ack_alert", alert_key="low:all:J:3", ack_date=today, reason="Kit J")
        acks = [a for a in self.state()["acks"] if a["alert_key"] == "low:all:J:3"]
        self.assertEqual(acks, [{"alert_key": "low:all:J:3", "ack_date": today}])
        self.rejected(action="ack_alert", alert_key="x", ack_date="soon")

    def test_settings_are_validated_and_audited(self):
        self.accepted(action="set_settings", settings={"expiry_days": "45", "low_stock_total": 3})
        settings = self.state()["config"]["settings"]
        self.assertEqual((settings["expiry_days"], settings["low_stock_total"]), (45, 3))
        self.rejected(action="set_settings", settings={"expiry_days": "-1"})
        self.rejected(action="set_settings", settings={"nonsense": 1})
        self.accepted(action="set_settings", settings={"expiry_days": 30, "low_stock_total": 5})
        logged = self.client.get("/api/audit").get_json()["events"]
        self.assertTrue(any(e["action"] == "set_settings" and e["result"] == "accepted" for e in logged))

    def test_override_can_be_set_and_cleared(self):
        sid = self.study("PROTO-B")["id"]
        self.accepted(action="set_override", kit_type="m", study_id=sid, threshold=2)
        self.assertIn({"kit_type": "M", "study_id": sid, "threshold": 2}, self.state()["config"]["overrides"])
        self.accepted(action="set_override", kit_type="M", study_id=sid, threshold="")
        self.assertEqual(self.state()["config"]["overrides"], [])

    def test_new_study_is_built_up_in_one_place(self):
        self.accepted(action="add_study", code="NEW-1", title="New Study", sponsor="S", pi="P", phase="I", status="Enrolling")
        self.rejected(action="add_study", code="new-1")
        self.rejected(action="add_study", code="")
        self.rejected(action="add_study", code="NEW-2", status="Nonsense")
        sid = self.study("NEW-1")["id"]
        self.accepted(action="add_visit", study_id=sid, name="Week 2", day="14", kit_types="j, k")
        self.rejected(action="add_visit", study_id=sid, name="Week 2", kit_types="J")
        self.rejected(action="add_visit", study_id=sid, name="Week 3", kit_types="")
        self.rejected(action="add_visit", study_id=sid, name="Week 3", day="soon", kit_types="J")
        self.accepted(action="add_participant", study_id=sid, initials="zz", start_date="2026-01-05", status="Enrolled")
        self.rejected(action="add_participant", study_id=sid, initials="ZZ", start_date="2026-01-05")
        self.rejected(action="add_participant", study_id=sid, initials="AB", start_date="whenever")
        study = self.study("NEW-1")
        self.assertEqual(study["visits"][0]["kit_types"], ["J", "K"])
        person = study["participants"][0]
        self.assertEqual((person["initials"], person["status"]), ("ZZ", "Enrolled"))
        self.accepted(action="update_participant", participant_id=person["id"], status="Completed")
        self.rejected(action="update_participant", participant_id=person["id"], status="Nonsense")
        self.accepted(action="update_study", study_id=sid, code="NEW-1", title="Renamed", status="Closed")
        self.rejected(action="update_study", study_id=sid, code="PROTO-A")
        self.assertEqual(self.study("NEW-1")["title"], "Renamed")
        self.accepted(action="remove_visit", visit_id=study["visits"][0]["id"])

    def test_export_lists_the_study(self):
        serial = new_serial()
        self.accepted(action="receive", serial=serial, kit_type="K", expiry=FUTURE, study_id=self.study("PROTO-A")["id"])
        line = next(l for l in self.client.get("/api/export.csv").get_data(as_text=True).splitlines() if serial in l)
        self.assertIn(",PROTO-A,", line)


class UpgradeTest(unittest.TestCase):
    """A database from the previous release, where protocols sat under studies."""

    def test_protocols_become_studies_and_kits_stay_allocated(self):
        path = os.path.join(DB_DIR, "old.db")
        conn = sqlite3.connect(path)
        conn.executescript("""
            CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw_hash TEXT NOT NULL);
            CREATE TABLE studies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
            CREATE TABLE protocols (id INTEGER PRIMARY KEY AUTOINCREMENT, study_id INTEGER NOT NULL REFERENCES studies(id),
                                    code TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
            CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, protocol_id INTEGER NOT NULL REFERENCES protocols(id),
                                 name TEXT NOT NULL, day INTEGER, kit_types TEXT NOT NULL);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE TABLE low_stock_overrides (kit_type TEXT NOT NULL, protocol_id INTEGER NOT NULL DEFAULT 0,
                                              threshold INTEGER NOT NULL, PRIMARY KEY (kit_type, protocol_id));
            CREATE TABLE boxes (serial TEXT PRIMARY KEY, kit_type TEXT, product TEXT, lot TEXT, expiry TEXT,
                                quantity INTEGER NOT NULL DEFAULT 1, remaining_quantity INTEGER NOT NULL DEFAULT 1,
                                status TEXT NOT NULL, used_for TEXT, received_by TEXT, received_at TEXT, updated_at TEXT,
                                protocol_id INTEGER REFERENCES protocols(id));
            INSERT INTO studies (id, name) VALUES (7, 'Old study');
            INSERT INTO protocols (id, study_id, code, name) VALUES (3, 7, 'MY-PROTO', 'Mine');
            INSERT INTO visits (protocol_id, name, day, kit_types) VALUES (3, 'V1', 1, 'J');
            INSERT INTO settings VALUES ('expiry_days', 45), ('low_stock_protocol', 9);
            INSERT INTO low_stock_overrides VALUES ('J', 3, 2);
            INSERT INTO boxes (serial, kit_type, expiry, status, protocol_id) VALUES ('A1', 'J', '2030-01-01', 'in_stock', 3),
                                                                                    ('A2', 'J', '2030-01-01', 'in_stock', NULL);
        """)
        conn.commit()
        conn.close()
        original = server.DB_PATH
        server.DB_PATH = path
        try:
            server.init_db()
            server.init_db()    # safe to run on every start
        finally:
            server.DB_PATH = original
        conn = sqlite3.connect(path)
        conn.execute("PRAGMA foreign_keys = ON")
        self.assertEqual(conn.execute("SELECT code, title, sponsor FROM studies WHERE id = 3").fetchone(),
                         ("MY-PROTO", "Mine", "Old study"))
        self.assertEqual(dict(conn.execute("SELECT serial, study_id FROM boxes")), {"A1": 3, "A2": None})
        self.assertEqual(conn.execute("SELECT study_id, name FROM visits WHERE name = 'V1'").fetchone(), (3, "V1"))
        self.assertEqual(conn.execute("SELECT study_id, threshold FROM low_stock_overrides").fetchone(), (3, 2))
        settings = dict(conn.execute("SELECT key, value FROM settings"))
        self.assertEqual((settings["expiry_days"], settings["low_stock_study"]), (45, 9))
        self.assertNotIn("low_stock_protocol", settings)
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertNotIn("protocols", tables)
        self.assertEqual(conn.execute("SELECT count(*) FROM studies WHERE code = 'TAK-360-2002'").fetchone()[0], 1)
        conn.execute("UPDATE boxes SET study_id = 3 WHERE serial = 'A2'")   # foreign keys still work
        conn.close()


if __name__ == "__main__":
    unittest.main()
