# From zero to staging to delivery

## Important product rule

The app must use a protocol master, not assumptions:

```text
read serial -> identify kit -> select study, participant and visit
            -> check the visit needs this kit type
            -> mark the kit used (a visit not planned needs a reason)
```

Each serial is one kit. The final configuration must include, for every study:

| Study ID on the label | Visit | Schedule day | Kit types needed |
|---|---|---:|---|
| supplied by client | Visit 1 | 1 | J |

The studies, visits and participants in the app today are dummy data.

## Scenario coverage

The staging test set should cover each of these for every kit type and visit
rule:

1. New kit received with a valid serial, label, and expiry.
2. A photo or uploaded image fills the label fields.
3. OCR misses one field; the field is flagged for review.
4. OCR produces a suspicious date; the user must confirm/correct it.
5. Serial already exists; receipt is rejected.
6. Box is expired; receipt is rejected.
7. Visit is valid; the kit becomes `used` and stock falls by one.
8. Kit is unallocated; choosing a protocol at use allocates it first.
9. Stock reaches the low stock quantity; the alert appears overall and per
   study.
10. A later scan of a used kit is rejected.
11. Visit has no configured quantity; use is blocked.
12. Unplanned visit is entered with a required reason.
13. Damaged, recalled, or expired box is removed once.
14. Used or removed box cannot be removed again.
15. Same event is retried; it is applied only once.
16. Device goes offline; action is saved locally and later synchronized.
17. Synchronization conflicts with another user; the server result is shown in
    Needs attention.
18. CSV contains kit type, expiry, study, status, and usage.
19. User signs off a visit; the sign-off appears in audit without changing
    inventory.
20. Session expires; the user must sign in again before synchronization.

## Step 0: confirm accounts and ownership

1. Verify the GitHub Student Developer Pack at
   <https://education.github.com/pack>.
2. Open the Azure offer in the Pack and claim the student Azure subscription
   if eligible. The current Pack page advertises Azure access and $100 credit
   for eligible students; confirm the exact current terms in your account.
3. Keep the student subscription for development/staging only.
4. Create a client-owned GitHub organization/repository before production.
5. Create a client-owned hosting/billing account before delivery.

Do not put passwords, API keys, or student subscription secrets in the
repository or chat.

## Step 1: create the repository

Create a private repository named `lab-kit-tracker`, then from the project
folder run:

```bash
git init
git add .
git commit -m "Prepare lab kit tracker staging"
git branch -M main
git remote add origin https://github.com/OWNER/lab-kit-tracker.git
git push -u origin main
```

Use a GitHub token or browser authentication when GitHub requests credentials.

## Step 2: choose hosting

### Render

- Fastest path for the current Flask Docker app.
- Render Free is appropriate only for disposable staging.
- The included Blueprint uses a paid Starter service and persistent disk so
  SQLite survives restarts.
- Production should use a paid persistent service or managed database.
- Move production billing to the client before delivery.

### Azure Student

- Best use of the student benefit for persistent staging without depending on
  Render Free storage.
- Deploy the Docker image to Azure App Service or Container Apps.
- Use a managed database/storage service for production rather than relying on
  a local SQLite filesystem.
- Azure setup has more moving parts, so Render is the faster first staging
  demonstration.

## Step 3: deploy staging

### Render staging

1. Render Dashboard -> New -> Blueprint.
2. Connect the private GitHub repository.
3. Select `render.yaml`.
4. Confirm whether the service is paid Starter or disposable Free.
5. Set a separate staging `KIT_SECRET`.
6. Deploy.
7. Open the HTTPS URL in iPhone Safari.

### Azure staging

1. Activate the student Azure subscription.
2. Create a resource group named `lab-kit-staging`.
3. Create a container/app service from the repository Dockerfile.
4. Configure `KIT_SECRET` as a secret environment variable.
5. Use a staging database/storage resource.
6. Enable HTTPS and restrict administrative access.
7. Open the generated HTTPS URL in iPhone Safari.

## Step 4: load non-production fixtures

Use the ten supplied label images as test fixtures only. Do not load real
participant data. For each fixture, record the expected:

- serial/barcode
- kit type
- protocol
- lot
- expiry
- visit

The fixture is not complete until the client confirms the expected values.

## Step 5: staging acceptance

Run the complete scenario list above on a real iPhone over HTTPS. Record the
expected and actual stock by kit type after every scan. Test:

- Safari reload
- camera permission
- offline mode
- reconnect and synchronization
- two users scanning the same serial
- service restart
- CSV and audit output

Staging passes only when inventory totals match the signed protocol matrix.

## Step 6: production delivery

1. Obtain client approval of the staging results.
2. Create production resources under the client-owned account.
3. Use a separate production database and secret.
4. Configure backups, monitoring, HTTPS, and access controls.
5. Create client user accounts; remove demo users.
6. Load the signed protocol master.
7. Run a final smoke test with non-sensitive test data.
8. Hand over the URL, user instructions, support contact, backup owner, and
   recovery procedure.
9. Keep staging separate from production.
