# Secret Rotation Runbook

**Why:** `server/.env` was tracked in **25 git commits**. A hash comparison of the
historical blobs against the live file proved these are **byte-identical — never
rotated**: `JWT_SECRET`, `ENCRYPTION_KEY`, `ANCHOR_WEBHOOK_SECRET`, `DATABASE_URL`,
`SMTP_PASS`, `CLOUDINARY_API_SECRET`. (`ANCHOR_API_KEY` was rotated.) The repo is
private, so exposure is limited to anyone who has ever cloned it — contractors, old
laptops, a leaked GitHub token. `docs/GO_LIVE_CHECKLIST.md:14` lists this as an
unchecked launch blocker.

**What each leaked secret grants:** `JWT_SECRET` → forge a session for **any user,
including an admin** (and it is the OTP pepper). `ANCHOR_WEBHOOK_SECRET` → forge
signed inbound credits. `ENCRYPTION_KEY` → decrypt every stored BVN/CAC/IG/WA token
**and** forge the BVN-dedup HMACs. `DATABASE_URL` → direct production DB access.

**Expected downtime:** none. **Expected user impact:** everyone is signed out once
(`JWT_SECRET`), which is the point.

**Rollback:** every step is independently revertible by putting the old value back
on Render and redeploying — EXCEPT `ENCRYPTION_KEY`, which must be rolled back
together with a reverse data migration. Do that one last, and only after a clean
dry run.

---

## Pre-flight (do this before the window)

- [ ] Confirm you can reach the Render dashboard and the Anchor dashboard.
- [ ] Confirm the Anchor **live** webhook config page is open (you'll paste a new secret).
- [ ] Generate the new values and store them in your password manager **first**:
      ```bash
      openssl rand -hex 32   # JWT_SECRET       (also fine: 64 hex chars)
      openssl rand -hex 32   # ENCRYPTION_KEY   (MUST be exactly 64 hex chars)
      ```
- [ ] Note the current values (password manager) so rollback is possible.
- [ ] Verify the app is otherwise healthy: `/health` returns ok, latest deploy green.

---

## Step 1 — `JWT_SECRET` (signs out every user; also re-peppers OTPs)

1. Render → server service → Environment → set `JWT_SECRET` to the new value.
2. Save (triggers redeploy). Wait for the boot marker in logs.
3. **Verify:**
   - Old app session gets 401 → app returns to login. Log in again: works.
   - Request an OTP and complete a login/reset with it.
4. ⚠️ In-flight OTPs issued before the change will fail (they were HMAC'd with the
   old pepper). Users just request a new code. Nothing to clean up.

## Step 2 — `ANCHOR_WEBHOOK_SECRET`

1. Anchor dashboard → Webhooks → regenerate/replace the signing secret for
   `https://server-kashbook.onrender.com/webhooks/anchor`.
2. Render → set `ANCHOR_WEBHOOK_SECRET` to the new value → save/redeploy.
3. **Verify:** trigger a real event (small inbound transfer, or Anchor's "resend"
   on a past delivery). Logs must show the event parsed — **not** `signature
   mismatch — rejecting`.
   - If you see rejections, the two values differ: re-copy and redeploy.
   - Verification is fail-closed in production, so a mismatch drops events. The
     5-minute reconcile poller still books inbound credits meanwhile, so money is
     not lost while you fix it.

## Step 3 — `DATABASE_URL` password

1. Render → Postgres instance → rotate/reset the password.
2. Copy the new **Internal** connection string into the server service's
   `DATABASE_URL` → save/redeploy.
3. **Verify:** `/health` returns ok (it runs `SELECT 1`), and the app loads data.
4. Update your local `server/.env` too, or local scripts stop working.

## Step 4 — `SMTP_PASS` / `TXN_SMTP_PASS`

1. Mail host → regenerate the mailbox password(s).
2. Render → update `SMTP_PASS` (and `TXN_SMTP_PASS` if separate) → redeploy.
3. **Verify:** trigger an email OTP (`/auth/send-otp` with an email identifier) and
   confirm delivery; check logs for `[Nodemailer Error]`.

## Step 5 — `CLOUDINARY_API_SECRET`

1. Cloudinary console → Settings → Security → regenerate the API secret.
2. Render → update `CLOUDINARY_API_SECRET` → redeploy.
3. **Verify:** upload a profile photo or business logo in the app.

## Step 6 — dormant provider keys (no verification needed)

Rotate/revoke in each provider's dashboard and update Render if still set:
`TERMII_API_KEY`, `DOJAH_SECRET_KEY`, `MONO_SECRET_KEY`, `FLW_SECRET_KEY`,
`FLW_SECRET_HASH`. These are unused by the live NG flow (Sendchamp + Anchor), so
breakage risk is nil — but they were exposed.

## Step 7 — `ENCRYPTION_KEY` (LAST — requires a data migration)

This key encrypts stored BVNs/CAC numbers/IG+WA tokens **and keys the HMAC dedup
index** (`kycBvnHash`, `kycCacHash`, `bvnHash`). Swapping the env var alone would
leave every value undecryptable *and* silently break BVN-reuse prevention.
`decrypt()` passes through non-`enc:v1:` strings, so a botched rotation fails
**silently** — the script below fails loudly instead.

1. **Dry run** (reads only, proves every ciphertext decrypts):
   ```bash
   cd server
   ENCRYPTION_KEY_OLD=<current> ENCRYPTION_KEY_NEW=<new> node scripts/reencrypt-key-rotation.js
   ```
   Expect `DRY RUN complete — every ciphertext decrypted cleanly with the OLD key.`
   Any `FATAL` → stop; the OLD key isn't the live one. Nothing was written.

2. **Apply** (single transaction; rolls back entirely on any error):
   ```bash
   ENCRYPTION_KEY_OLD=<current> ENCRYPTION_KEY_NEW=<new> node scripts/reencrypt-key-rotation.js --apply
   ```
   Expect `APPLIED: N rows rewritten.` then `POST-CHECK OK: M values decrypt with
   ENCRYPTION_KEY_NEW.`

3. Render → set `ENCRYPTION_KEY` to the new value → redeploy.

4. **Verify:**
   - Open the Bank Account / KYC screen for an existing verified business — it must
     load without a decrypt error.
   - Submit a new account request using a BVN **already on another business**: it must
     still be refused (`BVN_ALREADY_VERIFIED`). That proves the HMAC index survived.
   - Instagram/WhatsApp inbox still loads (those tokens were re-encrypted too).

5. Side effects (expected): `KycCheckCache` and `KycCheckAttempt` are cleared —
   their hashes are of values we never store and can't be recomputed. Effect is a
   cold KYC cache and reset per-user attempt counters.

---

## Post-rotation

- [ ] Re-run the exposure check — every var must now read `no (rotated)`:
      ```bash
      # compares live server/.env against every historical git blob, by hash only
      node scripts/check-secret-exposure.js
      ```
- [ ] Enable the commit guard so this can't recur:
      ```bash
      git config core.hooksPath .githooks
      ```
- [ ] Tick `docs/GO_LIVE_CHECKLIST.md:14`.
- [ ] Optional: purge history with `git filter-repo --path server/.env --invert-paths`
      and force-push. **Rotation is the control that matters** — purging alone would
      not have protected anything, and every clone still holds the old objects.
