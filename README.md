# Lab kit tracker (build, not deployed)

See [fixes.md](fixes.md) for the QA findings and applied corrections, and
[system-workflow.md](system-workflow.md) for the expected workflow, outputs,
dependencies, and hosting prerequisites. See [STAGING.md](STAGING.md) for the
installation-free deployment and acceptance checklist, and
[DELIVERY-PLAN.md](DELIVERY-PLAN.md) for the complete scenario, staging, and
production handoff process.

Receive, use, remove and sign off lab kits. The client only needs one HTTPS
link in Safari; no Python, Node, or other service installation is required on
the iPhone. The app works offline on the device and sends to the server when
the connection returns. The server is the master copy.

## Run it locally

    pip install -r requirements.txt
    python3 server.py seed     # creates two test logins and prints their passwords once
    python3 server.py          # open http://127.0.0.1:5000

On an iPhone, the app needs HTTPS for the camera and for offline saving. Local
testing uses 127.0.0.1; the included Render configuration provides HTTPS. For
staging, connect the repository to Render and deploy `render.yaml`; the Docker
image contains all server dependencies. The persistent disk prevents the
SQLite staging database from disappearing on restart.

## What it does

- **Sign in:** each person has their own login. The session lasts one 8-hour
  shift, and the server logs out after 30 minutes idle.
- **Receive:** open the deployed HTTPS link directly on the iPhone and use its
  rear camera to read the barcode and label. The barcode is intentionally only
  the box serial/key; OCR reads the printed label fields separately. Barcode
  capture fills the serial and OCR fills kit type, lot, expiry, and visit.
  A phone photo and manual entry are fallbacks.
- **Use:** scan the box again with the iPhone camera, enter participant
  initials, and select the participant visit. The configured protocol quantity
  is deducted automatically. A visit not planned for that kit needs a reason.
- **Remove:** a reason is required (expired, damaged, recall, other).
- **Sign off:** records that a visit was signed off.
- **Sheet:** all kits on the device, with pending items marked. Download as
  Excel (CSV), also works offline.
- **Audit:** every action, who did it, when (server time), and the result.
  Events are never edited or deleted.
- **Needs attention:** actions the server refused, with the reason.

## Offline

- The app and the label reader are saved on the device (service worker).
- Every action is saved on the device first, then sent. Sending is safe to
  repeat: each action has an ID, and the server returns the old result instead
  of saving twice.
- The reader runs on the device, so it works without internet.

## Label reading

- Reads kit type, lot, expiry and visit from the printed text. The serial comes
  from the phone barcode detector or OCR. The reader runs several rotated,
  cropped, enlarged, contrast-stretched passes and can OCR a still photo when
  live video is difficult.
- Tested on the 10 sample boxes (see below). Always check every field against
  the box before saving.

## Test results (local, headless Chromium)

- Sign in, receive, use while offline, reload while offline, sync when back
  online, refused duplicate, CSV export, audit page: all passed.
- Reader on the 10 sample photos (run through a simulated camera):
  - Fully correct: boxes A, D, F.
  - Some fields missed and flagged for the lab: B, C, E, I, J.
  - Wrong but not flagged (the lab must catch these): G (lot character), H (lot
    digits and expiry year 2028 instead of 2026).
  - Phone speed not measured yet. Expect slower than this machine.

## Not done yet (before real use)

- Hosting on Render/GitHub, HTTPS, and a database that suits the hosting plan.
- Two-factor sign-in, and real password reset.
- Real protocol values and deduction quantities (the current staging default is
  one unit per configured visit).
- Vendor shipment list check, if the client provides one.
- Reader speed and accuracy on an iPhone 12 with real boxes.
- HIPAA agreement with the host before any real participant data.
