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
- **Receive:** take a photo of the label or upload an image. The same reader
  handles both and fills the serial, kit type and expiry, plus the lot when it
  is readable. Each serial is one kit. The serial is the reference for
  everything else. Check the fields against the kit, then save.
- **Allocate:** a received kit goes to a protocol or to unallocated stock. The
  app suggests the protocol printed on the label, or the only protocol that
  needs that kit type. If several need it, the person chooses. If none do, it
  goes to unallocated stock. The Sheet can move a kit at any time.
- **Use:** read the kit, enter participant initials, and select the visit. The
  visits come from the kit's protocol. Using an unallocated kit allocates it. A
  visit not planned for that kit needs a reason.
- **Remove:** a reason is required (expired, damaged, recall, other).
- **Sign off:** records that a visit was signed off.
- **Sheet:** usable stock by kit type (quantity, next expiry, allocation), then
  all kits on the device with pending items marked. Filter by protocol or
  unallocated. Download as Excel (CSV), also works offline.
- **Alerts:** a pop-up lists kits expiring within the set number of days and
  kit types at or below the low stock quantity, overall and per protocol. See
  below.
- **Admin:** set the alert days and quantities, set a different low stock
  quantity for one kit type, and add studies, protocols and visits. Anyone
  signed in can change these for now. Every change is in the audit trail.
- **Audit:** every action, who did it, when (server time), and the result.
  Events are never edited or deleted.
- **Needs attention:** actions the server refused, with the reason.

## Offline

- The app and the label reader are saved on the device (service worker).
- Every action is saved on the device first, then sent. Sending is safe to
  repeat: each action has an ID, and the server returns the old result instead
  of saving twice.
- The reader runs on the device, so it works without internet.

## Alerts

- The pop-up opens when the app opens, after a use or removal, and after
  receiving a kit that is already close to expiry. Receiving ordinary stock does
  not interrupt, so a shipment can be booked in without a pop-up on every kit.
- Acknowledging hides an alert for that person until the next day. It returns
  until the kit is used, removed or restocked. A lower count alerts again the
  same day. The red alert count at the top reopens the full list at any time.
- Expired kits do not count as stock.
- A kit type is only checked where it has held stock, so a protocol that has
  never been given a kit type does not alert.
- Alerts appear inside the app only. There is no email or phone notification
  while the app is closed.

## Label reading

- Reads kit type, expiry, serial and lot from a still photo. The reader runs
  several rotated, enlarged, contrast-stretched passes and stops once it has the
  serial, kit type and expiry. A barcode fills the serial only where OCR misses
  it and the browser can read barcodes (iPhone Safari cannot).
- Tested on the 10 sample boxes (see below). Always check every field against
  the box before saving.

## Tests

    python3 -m unittest discover tests

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
- Real studies, protocols and visit schedules (the current ones are dummy data).
- Editing or deleting studies, protocols and visits (Admin can only add them).
- Vendor shipment list check, if the client provides one.
- Reader speed and accuracy on an iPhone 12 with real boxes.
- HIPAA agreement with the host before any real participant data.
