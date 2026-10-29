# QA fixes

## QA scope

The local application was checked through the browser and server boundary:

- sign-in and invalid sign-in
- receive, duplicate receive, and stock display
- use with a planned visit
- use with an unplanned visit and reason
- removal and repeat removal
- sign-off validation
- audit and CSV surfaces
- offline queue paths by code review
- OCR parsing edge cases
- malformed sync requests

## Fixed issues

| ID | Severity | Area | Defect | Fix |
|---|---|---|---|---|
| QA-001 | High | Label reader | Dates such as `31-Feb-2027` were converted into a value even though the calendar date does not exist. | `parseExpiry` now checks the actual number of days in the month before returning a date. |
| QA-002 | High | Remove workflow | A kit already marked `used` or `removed` could be removed again by a crafted request, creating an incorrect state transition. | Both the browser pre-check and server rule now require `in_stock` before removal. |
| QA-003 | High | Receive API | The server accepted unknown kit types, blank lots, and malformed/nonexistent expiry dates when requests bypassed the UI. | The server now validates kit types A-J, requires a lot, and requires a real ISO `YYYY-MM-DD` date. |
| QA-004 | Medium | Remove details | The optional details field was displayed but discarded before sync. | Details are appended to the persisted removal reason so the audit and stock sheet retain them. |
| QA-005 | Medium | Sync API | A non-list `events` value or a non-object event could cause an exception instead of a clear client error. | The endpoint now returns HTTP 400 for a non-list and a rejected result for each malformed event object. |
| QA-006 | High | Phone scanning | The receive reader could use the wrong camera on desktop, and the use workflow had no phone-camera scan action. | Mobile devices now request the rear camera, use mode has its own scan button, and label-photo OCR is available as a fallback. |
| QA-007 | High | OCR accuracy | Small rotated label text, especially compact expiry text adjacent to lot text, was often missed by a single full-frame OCR pass. | The free local reader now runs rotated, cropped, enlarged, contrast-stretched passes and supports photo OCR; date parsing accepts compact and numeric separators while validating real calendar dates. |

## Remaining risks before hosting

- The demo protocol and test credentials are not production configuration.
- SQLite is suitable for local/single-instance use, but hosted multi-instance deployment needs a managed database or a single durable instance.
- HTTPS is required for camera access and should be enforced at the hosting edge.
- Real-device OCR accuracy and speed still need testing on the target iPhone and representative labels.
- Authentication needs production password provisioning, reset, and preferably MFA.
- A production deployment needs secrets configured through the host environment, not source files.

## Validation status

The browser flow passed locally for sign-in, receive, use, online sync, stock count, and page rendering. Regression checks for the server fixes were run against the Flask test client, and the label-reader change was reviewed against its loaded browser source. The repository has no configured npm test suite; `package.json` currently contains a placeholder test command.
