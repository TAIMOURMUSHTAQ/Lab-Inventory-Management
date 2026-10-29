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

## Receive workflow

1. Point the iPhone camera at the kit barcode and label.
2. The browser barcode reader fills the serial; on supported browsers this is
   decoded directly and otherwise OCR attempts to read the printed serial.
3. OCR fills the label fields; manual entry is only the fallback.
3. Verify kit type, lot, expiry, and product/protocol against the physical box.
4. Save the receipt.
5. The app stores the action locally first and marks it as pending if it cannot
   reach the server.
6. The server accepts only kit types A-J, a non-empty lot, a valid ISO expiry,
   and a non-expired kit. Duplicate serials are rejected.

The camera reader does not read the serial. The serial always comes from the
scanner or manual entry.

## Use workflow

1. Select **Use** and scan the box serial.
2. Enter participant initials.
3. Select the visit configured for the kit type.
4. The configured protocol quantity is selected automatically for that visit.
5. If the visit is not planned for that kit, select **Other** or an
   unplanned visit and provide a reason.
6. Record the use.

Only an in-stock, non-expired kit can be used. A successful use deducts the
configured quantity from `remaining_quantity`, records the participant and
visit, and changes the status to `used` when the remaining quantity reaches
zero.

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

- **Sheet:** current kit inventory, total quantity, remaining quantity, status,
  lot, expiry, usage, receiver, and pending state.
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
- Provide the signed kit-type/visit deduction table. Staging currently uses
  quantity `1` for every configured visit; this is a safe placeholder, not the
  final protocol.
- Replace demo protocol values and seed users.
- Configure HTTPS, backups, logging, and access controls.
- Complete device OCR testing and required privacy/compliance agreements before
  real participant data is used.
