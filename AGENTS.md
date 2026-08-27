# AGENTS.md

## Self-Improvement Directive (from recurse.bot)

**IMPORTANT:** Update this file whenever you learn something important about this repo.

Capture both wins and misses (what to repeat, what to avoid), plus collaborator preferences (rapport cues). Be specific: include exact commands, file paths, env vars, and concrete examples.

## Project Overview

This repo contains a staged Cloudflare replacement for the production Railway/Mailgun relay. No Cloudflare production cutover or production recovery drill has occurred; legacy code and state remain the rollback path.

- **Target inbound:** Cloudflare Email Routing → Worker `email()` → D1 dedupe/job → XMTP Queue → singleton Container → `email.inbound.v1`.
- **Target outbound:** allowlisted XMTP `email.send.v1` → live Container stream → D1 → email Queue → native Cloudflare Email Service → `email.send.result.v1`.
- **Target persistence:** D1 owns relay application state. The active encrypted XMTP SQLite database stays on local Container disk and is quiesced into HMAC-signed multipart R2 snapshots with a D1 freshness anchor.
- **Legacy rollback:** root `src/` remains the Railway Node service using Mailgun and `DATA_DIR/relay.sqlite`.

Only one production XMTP listener may run across Railway and Cloudflare. `max_instances=1` limits Cloudflare instances but does not stop Railway. Never work around missing production state by enabling a new XMTP installation.

## Setup / Commands

- Install all deps: `npm ci && npm ci --prefix cf-worker && npm ci --prefix container`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Dev (ts-node-dev): `npm run dev`
- Prod (compiled): `npm start`
- Inbound webhook smoke test: `npm run fake:mailgun`
- XMTP→SMTP integration test: `npm run test:integration` (requires `.env` vars; see `.env.example`)
- Edge typecheck/tests: `npm run typecheck:cloudflare && npm --prefix cf-worker test`
- Cross-layer Worker/smoke tests: `npm run test:cloudflare`
- Container validation: `npm run typecheck:container && npm run build:container && npm run test:container`
- Synthetic offline recovery drill: `npm --prefix container run recovery:drill` (not production F/G evidence)
- Wrangler bundle check: `npm run cf:dry-run` (requires Wrangler network access; it does not prove deployed bindings)
- Smoke CLI: `node scripts/cloudflare-smoke.mjs --suite safe|local|production|recovery|all`

## Repo Structure

- `src/index.ts`: process entrypoint; starts HTTP server + XMTP loops
- `src/httpServer.ts`: Express `/healthz` + Mailgun inbound webhook
- `src/db.ts`: SQLite schema + idempotent insert/update helpers
- `src/xmtp.ts`: ENS resolution + XMTP client helpers
- `src/messages.ts`: Zod schemas + message formats (`email.send.v1`, result payload)
- `scripts/fake-mailgun-inbound.js`: local webhook sender that signs payloads
- `cf-worker/`: target Edge Worker, D1 migrations/importer, Queues, Email Routing/Sending, R2 proxy, watchdog, and Container binding
- `container/`: target always-on `@xmtp/node-sdk` listener, health/readiness, identity inspection, signed multipart backup/restore, and recovery drill
- `scripts/cloudflare-smoke.mjs`: local/production A–J smoke harness; destructive recovery requires exact confirmation
- `docs/cloudflare-migration-runbook.md`: authoritative provisioning, handoff, DNS/email/frontend, recovery, verification, and rollback procedure
- `.github/workflows/cloudflare-relay.yml`: validation plus separate protected `deploy-paused` and `activate-pre-mx` actions; it never changes MX

## Env Vars (high-signal)

See `.env.example`.

Legacy Railway/Mailgun only:

- `DATA_DIR`: persistent storage directory (Railway: `/data`)
- `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_WEBHOOK_SIGNING_KEY`, `MAILGUN_FROM`
- `XMTP_BOT_KEY`: bot wallet private key (hex, with or without `0x`)
- `XMTP_DEAN_ADDRESS`: Dean recipient (`0x…` or `.eth`)
- `XMTP_ALLOWED_SENDERS`: legacy CSV allowlist (`0x…` and/or `.eth`, resolved at startup)
- `XMTP_ALLOW_NEW_INSTALLATION`: keep `false` for the existing production relay
- `XMTP_EMERGENCY_REVOKE_INSTALLATIONS`, `XMTP_ENFORCE_SINGLE_INSTALLATION`: legacy-only controls; never copy them into the Container
- `ETH_RPC_URL`: optional mainnet RPC for ENS resolution (defaults to `https://ethereum.publicnode.com`)

Cloudflare production secrets:

- `CONTAINER_SHARED_SECRET`, `RELAY_ADMIN_TOKEN`, independent `RECOVERY_ADMIN_TOKEN`
- existing `XMTP_BOT_KEY`
- `XMTP_EXPECTED_INBOX_ID`, `XMTP_EXPECTED_INSTALLATION_ID`
- independent `XMTP_SNAPSHOT_SIGNING_KEY`
- first-ever new deployment only: `XMTP_BOOTSTRAP_CONFIRM` together with explicitly approved `XMTP_ALLOW_NEW_INSTALLATION=true`; never use this for xmtp.mx migration

The Edge allowlist accepts normalized 64-character lowercase XMTP inbox IDs only. It does not resolve ENS names or wallet addresses. Use Cloudflare Secrets/Secrets Store and Wrangler variables; do not commit `.dev.vars` or secret values.

`RECOVERY_IMPORT_ENABLED` stays false except during a watchdog-paused, stopped-Container snapshot import. The local uploader reads the matching operator token from `CLOUDFLARE_RECOVERY_ADMIN_TOKEN`; never put it on the command line.

## Deployment notes

Target Cloudflare deployment is governed by `docs/cloudflare-migration-runbook.md`. A push to `main` runs validation only. The main-only protected `deploy-paused` action seeds D1 pause state and verifies the Container is not running; `activate-pre-mx` separately requires an anchored snapshot plus the protected legacy-listener-stopped attestation and verifies the restored identity. These gates do not independently observe Railway, so the operator must enforce and record the no-dual-listener window.

Legacy Railway rollback:

- Use `Dockerfile` (builds native deps for `better-sqlite3`).
- Mount a persistent volume at `/data` and set `DATA_DIR=/data`.
- Expose public URL for `POST /webhooks/mailgun/inbound`.
- Mailgun Route should forward `INBOUND_EMAIL_TO` to the webhook URL.
- Retain the service, volume, Mailgun settings, and exact identity until Cloudflare A–J plus recovery and rollback gates pass.

## Common Pitfalls / Gotchas

- `better-sqlite3` is a native module: Docker build installs `python3 make g++` (already in `Dockerfile`).
- ENS resolution uses `ETH_RPC_URL` (defaults to PublicNode mainnet RPC).
- XMTP Node SDK enforces a 10-installation limit per inbox. If you don't persist `DATA_DIR`, each deploy can burn a new installation slot.
- `DATA_DIR/xmtp-inbox-id.txt` pins the inbox ID to avoid accidentally running the relay under a different inbox/key.
- Mailgun inbound payload can be `multipart/form-data` or urlencoded; attachments are currently ignored (v1).
- Target inbound dedupe is SHA-256 over normalized SMTP envelope plus exact raw MIME; `Message-ID` is thread metadata. Target outbound dedupe uses XMTP `message.id`.
- Queues and D1 are not a shared transaction, and neither Cloudflare Email Service nor XMTP offers cross-system transactional idempotency. Persist before enqueue, quarantine accepted-but-unrecorded outcomes as `uncertain`, and never blindly retry them.
- Never copy a live XMTP SQLite file or run it on an R2 FUSE mount. Snapshot only after the isolated XMTP child exits and sidecar checks pass.
- HMAC authenticates a snapshot but does not prove freshness. Keep the D1 `snapshot_anchor`; publish the logical `latest.json` request only through the gated Worker path and never directly overwrite a mutable R2 pointer.
- The Container forbids emergency installation revocation. Missing/corrupt state is a `recovery_required` stop, not permission to register.
- Missing/invalid D1 `watchdog_pause` is fail-closed: Cron does not start/sweep and XMTP jobs retry. Only the authenticated start route writes explicit `paused:false`.

## Recent Learnings

- 2025-12-17: `express-rate-limit` latest major is v8 (v7.5.2 does not exist on npm); keep it aligned with `package-lock.json`.
- 2025-12-17: Use `@types/express@4` (Express 5 types can mismatch Express 4 runtime).
- 2025-12-17: `mailgun.js` types require at least one of `text/html/message/template`; send `text: ''` when only HTML is present.
- 2025-12-18: Mailgun 401/403 errors surface as `Unauthorized`; include status and credential/region hints in user-facing errors when propagating Mailgun failures.
- 2026-08-27: Cloudflare Container disks are ephemeral. Keep active SQLite local, quiesce the XMTP child, upload immutable signed multipart R2 objects, then publish the logical `latest.json` request last. D1 anchors the proven immutable manifest; steady state does not trust a mutable R2 pointer.
- 2026-08-27: Cloudflare Email Service and XMTP can produce accepted-but-unrecorded ambiguity. Record `uncertain` for manual reconciliation instead of retrying and risking duplicates.
- 2026-08-27: `cf-worker/wrangler.toml` is relative to `cf-worker/`; the Container image path is `../container/Dockerfile`.

## Agent Tips

- If you change message schemas, update `src/messages.ts`, `README.md`, and `FEATURES.md` together.
- Prefer additive DB changes (`CREATE TABLE IF NOT EXISTS`, new columns) unless you also add migrations.
- When adding env vars, update `.env.example` and this file.

## Rapport Cues

- Keep diffs small and focused; avoid unrelated refactors.
- Keep docs concise and concrete; use exact commands and file paths.
- No emojis; prefer short, actionable bullets.
