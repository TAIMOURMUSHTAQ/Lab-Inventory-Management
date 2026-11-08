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
- **Receive:** tap **Take photo** to use the phone camera, or **Upload image**.
  Both read the same still photo and fill the serial, kit type and expiry, plus
  the lot when readable. The lot is optional. Each serial is one kit, and the
  serial is the reference for everything else. Check the fields, then save.
- **Allocate:** a received kit goes to a study or to unallocated stock. The app
  suggests the study ID printed on the label, or the only study that needs that
  kit type. If several need it, the person chooses. If none do, it goes to
  unallocated stock. Move a kit from the Sheet or from the study page.
- **Use:** read the kit, then choose the study, participant and visit. The kit's
  study is filled in. Using an unallocated kit allocates it. A visit not planned
  for that kit needs a reason.
- **Remove:** a reason is required (expired, damaged, recall, other).
- **Sign off:** records that a visit was signed off.
- **Studies:** one card per study. Opening a card shows that study's details,
  visit schedule with the kits each visit needs, participants, and inventory on
  one page, and everything about the study is added or changed there. A protocol
  is not a separate record: the study holds its schedule, as in CRISP.
- **Sheet:** usable stock by kit type (quantity, next expiry, allocation), then
  all kits on the device with pending items marked. Filter by study or
  unallocated. Download as Excel (CSV), also works offline.
- **Settings:** the alert days and quantities, and a different low stock quantity
  for one kit type. Anyone signed in can change studies and settings for now.
  Every change is in the audit trail.
- **Alerts:** a pop-up lists kits expiring within the set number of days and kit
  types at or below the low stock quantity, overall and per study. See below.
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
- A kit type is only checked where it has held stock, so a study that has never
  been given a kit type does not alert.
- Alerts appear inside the app only. There is no email or phone notification
  while the app is closed.

## Label reading

The reader takes one still photo and runs on the device, so it works offline.

- **Serial:** from the barcode, using a bundled decoder that also works on iPhone
  Safari. A label can carry a barcode that is not the serial (Syneos labels do),
  so the printed number is compared. If they disagree, the app asks for a check.
  PPD serials are `39`, a letter `O`, then 8 digits.
- **Tilt and direction:** the photo is straightened by up to 20 degrees and turned
  using the barcode's direction.
- **Small print:** the lot and expiry line and the kit line are cropped from the
  full-size photo, enlarged and read several times.
- **Choosing a value:** every read is a vote. If the reads disagree on a date, even
  with one that is impossible, the app shows "Please check" instead of guessing.
- A blank field is not a failure: an expiry that is blacked out or handwritten is
  left blank and flagged. Always check every field against the kit before saving.

## Updates on phones

App files come from the network first, so a new release takes over by itself the
next time the app is opened online, and the page reloads once. The version shows
next to the signed-in email. Change `APP_VERSION` in `static/app.js` and `CACHE`
in `static/sw.js` together for each release that changes the large reader files.

## Tests

    python3 -m unittest discover tests

## Test results (local, headless Chrome, simulated iPhone browser)

Scored against the 12 sample images, with serials confirmed from their barcodes:

| Field | Before | Now |
|---|---:|---:|
| Serial | 4 | 12 |
| Kit type | 9 | 12 |
| Expiry | 8 | 11 |
| Lot (10 labels print one) | 3 | 9 |

- The expiry miss is the label with the printed date blacked out and handwritten
  over. It is left blank and flagged.
- On 20 tilted, turned and blurred copies, serial and kit type were 20 of 20 and
  expiry 18 of 20. Both wrong dates showed "Please check".
- The sample photos are small (768 by 1024). Speed and accuracy on a real iPhone
  camera photo are not measured yet.

## Not done yet (before real use)

- Hosting on Render/GitHub, HTTPS, and a database that suits the hosting plan.
- Two-factor sign-in, and real password reset.
- Real studies, visit schedules and participants (the current ones are dummy data).
- Vendor shipment list check, if the client provides one.
- Reader speed and accuracy on an iPhone with real boxes.
- A trained OCR service, if the on-device reader is not accurate enough.
- HIPAA agreement with the host before any real participant data.
