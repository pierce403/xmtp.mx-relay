# AGENTS.md

## Self-Improvement Directive (from recurse.bot)

**IMPORTANT:** Update this file whenever you learn something important about this repo.

Capture both wins and misses (what to repeat, what to avoid), plus collaborator preferences (rapport cues). Be specific: include exact commands, file paths, env vars, and concrete examples.

## Project Overview

This repo is an always-on Node.js service that relays between Mailgun inbound SMTP and XMTP:

- **Inbound (SMTP → XMTP):** Mailgun POSTs inbound email → signature verified → normalized → stored/deduped in SQLite → delivered to Dean over XMTP as `email.inbound.v1` JSON.
- **Outbound (XMTP → SMTP):** Any XMTP sender can send `email.send.v1` JSON to the bot → relay sends email via Mailgun → replies with `email.send.result.v1`.

Persistence:
- `DATA_DIR/relay.sqlite` stores relay state.
- XMTP Node SDK stores its local DB under `DATA_DIR/` (`xmtp-<env>-<inbox-id>.db3`). For production, mount `DATA_DIR=/data`.

## Setup / Commands

- Install deps: `npm install`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Dev (ts-node-dev): `npm run dev`
- Prod (compiled): `npm start`
- Inbound webhook smoke test: `npm run fake:mailgun`
- XMTP→SMTP integration test: `npm run test:integration` (requires `.env` vars; see `.env.example`)

## Repo Structure

- `src/index.ts`: process entrypoint; starts HTTP server + XMTP loops
- `src/httpServer.ts`: Express `/healthz` + Mailgun inbound webhook
- `src/db.ts`: SQLite schema + idempotent insert/update helpers
- `src/xmtp.ts`: ENS resolution + XMTP client helpers
- `src/messages.ts`: Zod schemas + message formats (`email.send.v1`, result payload)
- `scripts/fake-mailgun-inbound.js`: local webhook sender that signs payloads
- `cf-worker/`: optional/older Worker-based implementation (not part of the Node service)

## Env Vars (high-signal)

See `.env.example`.

- `DATA_DIR`: persistent storage directory (Railway: `/data`)
- `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_WEBHOOK_SIGNING_KEY`, `MAILGUN_FROM`
- `XMTP_BOT_KEY`: bot wallet private key (hex, with or without `0x`)
- `XMTP_DEAN_ADDRESS`: Dean recipient (`0x…` or `.eth`)
- `ETH_RPC_URL`: optional mainnet RPC for ENS resolution (defaults to `https://ethereum.publicnode.com`)

## Deployment Notes (Railway)

- Use `Dockerfile` (builds native deps for `better-sqlite3`).
- Mount a persistent volume at `/data` and set `DATA_DIR=/data`.
- Expose public URL for `POST /webhooks/mailgun/inbound`.
- Mailgun Route should forward `INBOUND_EMAIL_TO` to the webhook URL.

## Common Pitfalls / Gotchas

- `better-sqlite3` is a native module: Docker build installs `python3 make g++` (already in `Dockerfile`).
- ENS resolution uses `ETH_RPC_URL` (defaults to PublicNode mainnet RPC).
- Mailgun inbound payload can be `multipart/form-data` or urlencoded; attachments are currently ignored (v1).
- Keep idempotency intact: inbound dedupe uses Mailgun `message-id`/`Message-Id`; outbound dedupe uses XMTP `message.id`.

## Recent Learnings

- 2025-12-17: `express-rate-limit` latest major is v8 (v7.5.2 does not exist on npm); keep it aligned with `package-lock.json`.
- 2025-12-17: Use `@types/express@4` (Express 5 types can mismatch Express 4 runtime).
- 2025-12-17: `mailgun.js` types require at least one of `text/html/message/template`; send `text: ''` when only HTML is present.
- 2025-12-18: Mailgun 401/403 errors surface as `Unauthorized`; include status and credential/region hints in user-facing errors when propagating Mailgun failures.

## Agent Tips

- If you change message schemas, update `src/messages.ts`, `README.md`, and `FEATURES.md` together.
- Prefer additive DB changes (`CREATE TABLE IF NOT EXISTS`, new columns) unless you also add migrations.
- When adding env vars, update `.env.example` and this file.

## Rapport Cues

- Keep diffs small and focused; avoid unrelated refactors.
- Keep docs concise and concrete; use exact commands and file paths.
- No emojis; prefer short, actionable bullets.
