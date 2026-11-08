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
6. Confirm the login page, take photo, upload image, OCR autofill, receive,
   allocation, use, removal, sign-off, alerts, studies, settings, sheet, CSV, and audit
   workflows.
7. Run `python3 server.py seed` only against a controlled staging database if
   demo logins are required. Store the generated passwords in a secure channel.

## Staging acceptance checklist

- [ ] HTTPS URL opens on iPhone Safari
- [ ] Take photo opens the iPhone camera
- [ ] Upload image picks from the photo library
- [ ] A full-size iPhone photo is read without the page failing, and the time is recorded
- [ ] The deployed URL is opened on the phone itself, not only in a Mac tab
- [ ] The version next to the email matches this release
- [ ] OCR is tested with the label rotated 0, 90, and 270 degrees, and slightly tilted
- [ ] OCR is tested with expiry adjacent to lot text
- [ ] OCR result is reviewed before saving
- [ ] OCR fills serial, kit type, and expiry, including kits I, J, and K
- [ ] User can correct a field before saving
- [ ] Duplicate serial is rejected
- [ ] A kit needed by one study is suggested for that study
- [ ] A kit needed by several studies asks the person to choose
- [ ] A kit needed by none goes to unallocated stock and can be allocated later
- [ ] The expiry alert appears at the set number of days
- [ ] The low stock alert appears overall and per study at the set quantity
- [ ] An acknowledged alert stays hidden that day and returns the next day
- [ ] Settings changes take effect and appear in the audit
- [ ] A study card opens one page with its schedule, participants, and inventory
- [ ] Use and sign-off list only that study's participants
- [ ] Further use is rejected
- [ ] Offline receive/use queue resends after reconnection
- [ ] CSV includes kit type, expiry, and study
- [ ] Audit displays accepted and rejected events
- [ ] Restart does not lose staging data
- [ ] No real participant data is used in staging

## Before production

- Replace the dummy studies, visits and participants with the signed schedules
  before accepting a real transaction.
- Decide who may change studies and settings.
- Replace demo accounts with managed user accounts and password reset.
- Confirm backup/restore for the database.
- Review retention, access, and privacy requirements.
- Use a production database if more than one application instance is needed.
- Set a separate production `KIT_SECRET` and database.
