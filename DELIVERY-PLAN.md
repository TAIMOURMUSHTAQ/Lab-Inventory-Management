# From zero to staging to delivery

## Important product rule

The app must use a protocol master, not assumptions:

```text
scan serial -> identify box -> select participant visit
            -> find kit type + visit protocol quantity
            -> deduct that many units
            -> block if no rule exists
```

The final configuration must include, for every allowed combination:

| Kit type | Visit/protocol | Units inside box at receipt | Units deducted |
|---|---|---:|---:|
| I | Day 28 | supplied by client | supplied by client |

If different protocol names share a visit, the protocol identifier must also be
included in the key. The application should reject duplicate or missing rules.
It must never silently use `1`.

## Scenario coverage

The staging test set should cover each of these for every kit type and visit
rule:

1. New box received with a valid serial, label, lot, expiry, and starting
   quantity.
2. Barcode read automatically; OCR reads the label fields.
3. Barcode succeeds but OCR misses one field; the field is flagged for review.
4. OCR produces a suspicious lot or date; the user must confirm/correct it.
5. Serial already exists; receipt is rejected.
6. Box is expired; receipt is rejected.
7. Visit is valid and quantity is deducted automatically.
8. Visit is valid but remaining quantity is lower than the protocol quantity;
   use is rejected without changing inventory.
9. Remaining quantity reaches zero; the box becomes `used`.
10. A later scan of a depleted box is rejected.
11. Visit has no configured quantity; use is blocked.
12. Unplanned visit is entered with a required reason.
13. Damaged, recalled, or expired box is removed once.
14. Used or removed box cannot be removed again.
15. Same event is retried; it is applied only once.
16. Device goes offline; action is saved locally and later synchronized.
17. Synchronization conflicts with another user; the server result is shown in
    Needs attention.
18. CSV contains total quantity, remaining quantity, status, and audit details.
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
- starting quantity
- deduction quantity

The fixture is not complete until the client confirms the expected values.

## Step 5: staging acceptance

Run the complete scenario list above on a real iPhone over HTTPS. Record the
expected and actual remaining quantities after every scan. Test:

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
