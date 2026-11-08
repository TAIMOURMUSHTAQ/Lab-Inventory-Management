"""Server rules for allocation, single-kit stock, alert acknowledgements and admin.

Run:   python3 -m unittest discover tests
"""
import os
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

    def protocol(self, code):
        for study in self.state()["config"]["studies"]:
            for p in study["protocols"]:
                if p["code"] == code:
                    return p
        self.fail(f"no protocol {code}")

    def box(self, serial):
        return next(b for b in self.state()["boxes"] if b["serial"] == serial)

    def test_dummy_schedule_is_loaded(self):
        visit = next(v for v in self.protocol("PROTO-A")["visits"] if v["name"] == "Visit 2")
        self.assertEqual(visit["kit_types"], ["K"])
        self.assertEqual(self.state()["config"]["settings"]["expiry_days"], 30)

    def test_receive_accepts_kit_k_without_a_lot_as_one_kit(self):
        serial = new_serial()
        self.accepted(action="receive", serial=serial, kit_type="k", expiry=FUTURE, quantity=9)
        box = self.box(serial)
        self.assertEqual((box["kit_type"], box["quantity"], box["protocol_id"]), ("K", 1, None))

    def test_receive_rejects_unknown_protocol_and_bad_kit_type(self):
        self.rejected(action="receive", serial=new_serial(), kit_type="J", expiry=FUTURE, protocol_id=9999)
        self.rejected(action="receive", serial=new_serial(), kit_type="J1", expiry=FUTURE)

    def test_allocate_moves_stock_and_back_to_unallocated(self):
        serial = new_serial()
        pid = self.protocol("PROTO-A")["id"]
        self.accepted(action="receive", serial=serial, kit_type="J", expiry=FUTURE)
        self.accepted(action="allocate", serial=serial, protocol_id=pid)
        self.assertEqual(self.box(serial)["protocol_id"], pid)
        self.accepted(action="allocate", serial=serial, protocol_id=None)
        self.assertIsNone(self.box(serial)["protocol_id"])

    def test_use_needs_allocation_and_a_planned_visit_or_reason(self):
        serial = new_serial()
        pid = self.protocol("PROTO-A")["id"]
        self.accepted(action="receive", serial=serial, kit_type="J", expiry=FUTURE)
        self.rejected(action="use", serial=serial, participant="SM", visit="Visit 1")
        self.accepted(action="allocate", serial=serial, protocol_id=pid)
        self.rejected(action="use", serial=serial, participant="SM", visit="Visit 2")
        self.accepted(action="use", serial=serial, participant="SM", visit="Visit 1")
        box = self.box(serial)
        self.assertEqual((box["status"], box["used_for"]), ("used", "SM | Visit 1"))
        self.rejected(action="allocate", serial=serial, protocol_id=None)

    def test_unplanned_visit_is_allowed_with_a_reason(self):
        serial = new_serial()
        self.accepted(action="receive", serial=serial, kit_type="J", expiry=FUTURE,
                      protocol_id=self.protocol("PROTO-A")["id"])
        self.accepted(action="use", serial=serial, participant="SM", visit="Visit 2", reason="Replacement")

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
        pid = self.protocol("PROTO-B")["id"]
        self.accepted(action="set_override", kit_type="m", protocol_id=pid, threshold=2)
        self.assertIn({"kit_type": "M", "protocol_id": pid, "threshold": 2}, self.state()["config"]["overrides"])
        self.accepted(action="set_override", kit_type="M", protocol_id=pid, threshold="")
        self.assertEqual(self.state()["config"]["overrides"], [])

    def test_new_study_protocol_and_visit(self):
        self.accepted(action="add_study", name="New Study")
        self.rejected(action="add_study", name="new study")
        study = next(s for s in self.state()["config"]["studies"] if s["name"] == "New Study")
        self.accepted(action="add_protocol", study_id=study["id"], code="NEW-1")
        self.rejected(action="add_protocol", study_id=study["id"], code="new-1")
        self.rejected(action="add_protocol", study_id=9999, code="NEW-2")
        pid = self.protocol("NEW-1")["id"]
        self.accepted(action="add_visit", protocol_id=pid, name="Week 2", day="14", kit_types="j, k")
        self.rejected(action="add_visit", protocol_id=pid, name="Week 2", kit_types="J")
        self.rejected(action="add_visit", protocol_id=pid, name="Week 3", kit_types="")
        self.rejected(action="add_visit", protocol_id=pid, name="Week 3", day="soon", kit_types="J")
        self.assertEqual(self.protocol("NEW-1")["visits"][0]["kit_types"], ["J", "K"])

    def test_export_lists_the_allocation(self):
        serial = new_serial()
        self.accepted(action="receive", serial=serial, kit_type="K", expiry=FUTURE,
                      protocol_id=self.protocol("PROTO-A")["id"])
        line = next(l for l in self.client.get("/api/export.csv").get_data(as_text=True).splitlines() if serial in l)
        self.assertIn("Demo Study 2,PROTO-A", line)

    def test_existing_database_gets_the_new_column(self):
        columns = {row[1] for row in __import__("sqlite3").connect(server.DB_PATH).execute("PRAGMA table_info(boxes)")}
        self.assertIn("protocol_id", columns)


if __name__ == "__main__":
    unittest.main()
