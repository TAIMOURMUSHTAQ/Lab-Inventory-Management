# Expected system behavior

## Purpose

Lab Kit Tracker records the custody and use of study kits. The server is the
authoritative copy. A device may continue recording actions without a network
connection, then synchronizes them when connectivity returns.

## Users and access

1. A user signs in with a lab account.
2. The server creates an eight-hour shift session.
3. The server also expires the session after 30 minutes without activity.
4. The device may continue an already authenticated shift offline; first-time
   sign-in still requires a connection.

## Studies, protocols and visits

A study has protocols. A protocol has a visit schedule, and each visit lists the
kit types it needs. The current records are dummy data. Admin can add more.

## Receive workflow

1. Select **Take photo** or **Upload image**. Both use the same reader.
2. The reader fills the serial, kit type and expiry, and the lot when readable.
   A barcode fills the serial only if OCR misses it and the browser supports
   barcode reading.
3. The app suggests where the kit goes:
   - the protocol printed on the label, if it is a configured protocol code
   - otherwise the only protocol needing that kit type
   - if several need it, the person chooses a protocol or unallocated stock
   - if none need it, unallocated stock
4. Verify the fields against the physical kit and save.
5. The app stores the action locally first and marks it as pending if it cannot
   reach the server.
6. The server accepts a kit type of one or two letters, a valid ISO expiry, a
   non-expired kit and a known protocol. Duplicate serials are rejected. Lot is
   optional. Each serial is one kit.

## Allocation workflow

The Sheet lists an allocation control for every in-stock kit. A kit can move to
any protocol or back to unallocated stock. Each move is an audited event.
Allocating to a protocol with no visit for that kit type is allowed.

## Use workflow

1. Select **Use** and read or type the serial.
2. Enter participant initials.
3. Select the protocol and visit. The kit's protocol is preselected, with the
   visits that need this kit first.
4. If the visit is not planned for that kit, select **Other** or an unplanned
   visit and provide a reason.
5. Record the use.

Only an in-stock, non-expired, allocated kit can be used. Using an unallocated
kit, or choosing another protocol, moves the kit there first. A successful use
records the participant and visit and changes the status to `used`.

## Alert workflow

Alerts are worked out on the device from the kits it holds, including actions
still waiting to send, so they also work offline.

- **Expiry:** an in-stock kit expiring within `expiry_days` (default 30), or
  already expired.
- **Low stock, all stock:** usable kits of a type at or below `low_stock_total`
  (default 5).
- **Low stock, per protocol:** usable kits of a type allocated to a protocol at
  or below `low_stock_protocol` (default 5).

A kit type can have its own quantity for all stock or for one protocol. A scope
is checked only once it has held stock of that type.

The pop-up opens when the app opens, after a use or removal, and after receiving
a kit that is close to expiry. Acknowledging records an audited event and hides
the alert for that person until the next day. An alert for a lower count is a
new alert.

## Admin workflow

The Admin tab changes alert settings and adds studies, protocols and visits. It
needs a connection, because the changes apply to everyone. Any signed-in user can
make these changes for now. Each one is an audited event.

## Remove workflow

1. Select **Remove** and scan the box serial.
2. Choose a reason: expired, damaged, recall, or other.
3. Add optional details.
4. Confirm removal.

Only an in-stock kit can be removed. The reason and details are retained in the
stock record and audit event.

## Sign-off workflow

1. Select **Sign off**.
2. Enter participant initials and visit.
3. Submit the sign-off.

The server records the event in the immutable audit log. Sign-off does not
change kit stock.

## Offline and synchronization workflow

1. Every action receives a device-generated event ID and device timestamp.
2. The action is saved in browser local storage before the UI reports success.
3. The sheet shows pending actions as **to send**.
4. When online, the app sends queued events in a batch.
5. The server validates each event and uses the event ID to make retries safe.
6. Accepted events leave the queue.
7. Rejected events move to **Needs attention** with the server reason.
8. A user corrects the physical or entered data and records a new action.

## Outputs

- **Sheet:** usable quantity by kit type, then current kits with allocation,
  status, lot, expiry, usage, receiver, and pending state.
- **Audit:** up to the latest 500 events, including server timestamp, user,
  action, target, result, and message.
- **CSV:** a locally generated Excel-compatible CSV that also includes pending
  actions and works offline.
- **Needs attention:** locally retained actions rejected by the server.

## Dependencies

### Runtime

- Python 3
- Flask
- Werkzeug
- SQLite (included with Python)
- A modern browser with JavaScript and local storage
- HTTPS for camera access on deployed devices

### Bundled browser assets

- Tesseract.js
- English Tesseract trained data
- Service worker support for offline shell caching

### Development and QA

- Python standard library (`unittest`/Flask test client can be used)
- A Chromium-compatible browser for end-to-end testing
- Node.js/npm are not required by the server, and no npm test runner is
  currently configured despite the package manifest.

## Production prerequisites

- Set a strong persistent `KIT_SECRET`.
- Set a durable `KIT_DB` or migrate to a managed relational database for
  multi-instance hosting.
- Replace the dummy studies, protocols and visits with the signed protocols.
- Replace the seed users, and decide who may use the Admin tab.
- Configure HTTPS, backups, logging, and access controls.
- Complete device OCR testing and required privacy/compliance agreements before
  real participant data is used.
