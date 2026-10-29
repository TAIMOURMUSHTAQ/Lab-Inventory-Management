git init
git add .
git commit -m "Prepare lab kit tracker staging"
git branch -M main
git remote add origin https://github.com/OWNER/lab-kit-tracker.git
git push -u origin main# Staging deployment

## Recommended setup

Use Render for a disposable staging environment with the included Docker image
and `render.yaml`, or use the GitHub Student Pack's Azure benefit for staging
if you want the staging database to persist without paying Render.
This keeps the client side installation-free: the client opens the Render HTTPS
URL in iPhone Safari. Render builds and runs Python, Flask, Gunicorn, and the
database container; none of those are installed on the iPhone.

The checked-in Render Blueprint uses a paid Starter web service plus a
persistent disk, because SQLite must persist across restarts. A Render Free
service cannot attach a persistent disk; use Free only for UI/OCR smoke tests
with disposable fixtures, never for inventory records.

## Deploy

1. Put this folder in a private GitHub repository.
2. In Render, choose **New > Blueprint** and connect the repository.
3. Select `render.yaml`.
4. Deploy the service.
5. Open the generated `https://...onrender.com` address in Safari.
6. Confirm the login page, camera permission, barcode capture, OCR autofill,
   receive, repeated quantity deductions, removal, sign-off, sheet, CSV, and
   audit workflows.
7. Run `python3 server.py seed` only against a controlled staging database if
   demo logins are required. Store the generated passwords in a secure channel.

## Staging acceptance checklist

- [ ] HTTPS URL opens on iPhone Safari
- [ ] Camera permission is granted
- [ ] Barcode fills the serial
- [ ] The deployed URL is opened on the phone itself, not only in a Mac tab
- [ ] The rear camera is selected on iPhone
- [ ] A label photo can be used when live OCR is difficult
- [ ] OCR is tested with the label rotated 0, 90, and 270 degrees
- [ ] OCR is tested with expiry adjacent to lot text
- [ ] OCR result is reviewed before saving
- [ ] OCR fills kit type, lot, expiry, and visit
- [ ] User can correct a field before saving
- [ ] Duplicate serial is rejected
- [ ] Protocol quantity is deducted on each use scan
- [ ] Remaining quantity reaches zero at the correct scan
- [ ] Further use is rejected
- [ ] Offline receive/use queue resends after reconnection
- [ ] CSV includes quantity and remaining quantity
- [ ] Audit displays accepted and rejected events
- [ ] Restart does not lose staging data
- [ ] No real participant data is used in staging
- [ ] Every kit-type/visit rule has a configured deduction quantity
- [ ] A missing quantity rule blocks the transaction
- [ ] Repeated scans deduct the configured quantity, not a hard-coded default

## Before production

- Replace the demo protocol quantities with the signed table.
- Load the complete matrix of kit type, visit, and units-to-deduct before
  accepting a real transaction.
- Replace demo accounts with managed user accounts and password reset.
- Confirm backup/restore for the database.
- Review retention, access, and privacy requirements.
- Use a production database if more than one application instance is needed.
- Set a separate production `KIT_SECRET` and database.
