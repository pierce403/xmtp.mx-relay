# xmtp.mx relay

Bidirectional email/XMTP relay with a staged Cloudflare target and a retained Railway/Mailgun rollback service.

## Production status

No Cloudflare production cutover or recovery drill has occurred. The checked-in Cloudflare implementation is staged code, not proof of a live deployment. Railway, its persistent XMTP database, and Mailgun must remain intact until the production gates in [docs/cloudflare-migration-runbook.md](docs/cloudflare-migration-runbook.md) pass.

Do not run the Railway and Cloudflare XMTP listeners at the same time. Do not enable `XMTP_ALLOW_NEW_INSTALLATION` to work around a missing production database or backup.

## Staged Cloudflare architecture

- `cf-worker/` is the Edge Worker. It receives Cloudflare Email Routing messages, stores application state and dedupe keys in D1, publishes Queue jobs, sends outbound email through the native `send_email` binding, proxies R2, and supervises the singleton Container.
- `container/` is the always-on XMTP daemon. It uses `@xmtp/node-sdk` and `streamAllMessages(...)`, keeps the active encrypted SQLite database on local Container storage, and quiesces the XMTP child for signed multipart R2 snapshots.
- D1 stores inbound/outbound jobs, the resolved-inbox-ID allowlist, thread mappings, retry state, queue failures, watchdog state, and the monotonic R2 snapshot anchor.
- R2 stores immutable signed XMTP database parts, the pinned inbox file, and snapshot manifests. It is never mounted as a live SQLite filesystem.
- Cloudflare Queues decouple Email Routing and XMTP events from delivery. Consumers are at-least-once; D1 unique keys suppress ordinary replays.

Privileged relay and lifecycle endpoints require bearer authentication. The Container port is not public. `max_instances=1` limits Cloudflare, but operators must still enforce the one-listener Railway-to-Cloudflare handoff.

## Message formats

**SMTP → XMTP (`email.inbound.v1`)**

```json
{
  "type": "email.inbound.v1",
  "to": "deanpierce.eth@xmtp.mx",
  "from": "someone@example.com",
  "subject": "Hello",
  "text": "…",
  "html": null,
  "messageId": "<…>",
  "receivedAt": "2025-12-17T00:00:00.000Z"
}
```

**XMTP → SMTP (`email.send.v1`)**

```json
{
  "type": "email.send.v1",
  "to": ["someone@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Re: Hello",
  "text": "…",
  "html": null,
  "replyTo": "deanpierce.eth@xmtp.mx"
}
```

Relay replies with:

```json
{ "type": "email.send.result.v1", "ok": true, "mailgunId": "…", "error": null }
```

`mailgunId` remains the v1 field name for compatibility; after cutover it carries the Cloudflare provider message ID. An `error` of `delivery_state_unknown` is an ambiguous accepted-but-unrecorded outcome and must be manually reconciled, not blindly retried.

## Validate locally

Use Node.js 22 for the complete workspace:

```bash
npm ci
npm ci --prefix cf-worker
npm ci --prefix container

npm run typecheck
npm run build
npm run typecheck:cloudflare
npm --prefix cf-worker test
npm run test:cloudflare
npm run typecheck:container
npm run build:container
npm run test:container
npm --prefix container run recovery:drill
```

The local recovery drill uses synthetic state. It does not prove restoration of the production XMTP installation. An authenticated Wrangler dry run, Container image build, deployed readiness check, and production A–J smoke evidence are separate gates.

Smoke CLI:

```bash
node scripts/cloudflare-smoke.mjs --suite safe
node scripts/cloudflare-smoke.mjs --suite local
node scripts/cloudflare-smoke.mjs --suite production
node scripts/cloudflare-smoke.mjs --suite recovery \
  --confirm xmtp-mx-relay-production
```

Recovery is destructive and also requires the server-side recovery-drill flag. See the migration runbook for variables and acceptance criteria.

## Guarded pre-MX deployment

`.github/workflows/cloudflare-relay.yml` validates both the legacy rollback service and Cloudflare stack on relevant changes. A push to `main` validates only. It does not change MX or deploy production.

Two separate workflow-dispatch actions run only from `main`, require the exact `xmtp-mx-relay-production` confirmation, and use the protected `cloudflare-relay-production` environment.

`deploy-paused` applies D1 migrations, seeds the durable watchdog pause, deploys the Worker/Container code without starting the Container, and verifies that the listener remains stopped. It requires:

- `CLOUDFLARE_RELAY_RESOURCES_PROVISIONED`
- `CLOUDFLARE_RELAY_SOURCE_EXPORT_READY`
- `CLOUDFLARE_RELAY_PAUSED_DEPLOY_APPROVED`

After the signed snapshot is uploaded and anchored through the gated recovery route, `activate-pre-mx` starts the singleton and verifies the pinned/current/configured inbox and installation IDs. It requires:

- `CLOUDFLARE_RELAY_R2_SNAPSHOT_READY`
- `CLOUDFLARE_RELAY_LEGACY_LISTENER_STOPPED`
- `CLOUDFLARE_RELAY_ACTIVATION_APPROVED`

The jobs also require Cloudflare credentials, the exact deployed Workers.dev URL, the admin smoke token, and a real D1 database ID in Wrangler. The booleans are protected operator attestations, not a distributed lock: independently stop and verify Railway before activation and keep it stopped while Cloudflare is live. Email Routing, DNS, snapshot upload, D1 application-state import, MX cutover, and production acceptance remain manual runbook steps.

## Legacy Railway/Mailgun rollback

The root `src/` service, root `Dockerfile`, Mailgun dependencies, `relay.sqlite`, fake webhook helper, and Mailgun variables are intentionally retained during migration. Local legacy development remains:

```bash
cp .env.example .env
npm run dev
npm run fake:mailgun
```

Legacy endpoints are `GET /healthz` and `POST /webhooks/mailgun/inbound`. Mount `DATA_DIR=/data` on Railway. Never copy its live SQLite files; stop the relay and verify WAL/journal state before inspection or export.

## Documentation

- [Production migration, recovery, DNS, email, smoke tests, and rollback](docs/cloudflare-migration-runbook.md)
- [Edge Worker resources and interfaces](cf-worker/README.md)
- [XMTP Container persistence and recovery](container/README.md)
- [Feature status](FEATURES.md)
- [Outstanding production work](TODO.md)
