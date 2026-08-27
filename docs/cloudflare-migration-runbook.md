# xmtp.mx Cloudflare migration runbook

Last reviewed: 2026-08-27 UTC

## Status

**No production cutover has occurred.** At the time this runbook was written:

- <https://xmtp.mx> is still served by GitHub Pages.
- The XMTP daemon is still associated with the Railway production deployment.
- Cloudflare is not authoritative for <code>xmtp.mx</code>.
- The apex has no MX record, so Internet mail to <code>deanpierce.eth@xmtp.mx</code> does not currently have a working Mailgun route.
- The Cloudflare account, Workers Paid entitlement, Email Service onboarding, D1, R2, Queues, Container, DNS, and production secrets have not been provisioned from this workspace.

Code landing on <code>main</code> is not evidence of a deployment. Do not mark this migration complete until every production gate and acceptance test in this document is recorded as passing.

## Non-negotiable safety rules

1. The production listener remains <code>@xmtp/node-sdk</code> with <code>streamAllMessages(...)</code>. Do not replace it with scheduled polling.
2. Only one production listener may be active across Railway and Cloudflare. <code>max_instances = 1</code> prevents a second Cloudflare instance; it does not prevent Railway from running.
3. Normal production must have:
   - <code>XMTP_ALLOW_NEW_INSTALLATION=false</code>;
   - the existing <code>XMTP_BOT_KEY</code>;
   - the expected inbox ID;
   - the expected installation ID;
   - a verified R2 snapshot before a fresh Container filesystem starts.
4. Restore <code>xmtp-inbox-id.txt</code> and the encrypted XMTP database before constructing <code>Client</code>.
5. Never copy an active SQLite database. Never use a live R2 FUSE mount as the XMTP database.
6. A backup is publishable only after the XMTP child has exited, WAL/journal safety checks pass, every immutable signed-snapshot object is uploaded, and a read-back hash check succeeds.
7. On an empty Container filesystem, a missing, stale, corrupt, mismatched, unanchored, or unverifiable backup is a hard stop. Never “recover” by enabling a new installation. Existing complete local DB/pin state may start only under the local-state checks described below and must immediately produce a verified R2 backup.
8. Do not remove Railway, Mailgun, GitHub Pages, or the Vercel fallback until the relevant rollback path has been exercised.
9. If the Node SDK cannot be safely quiesced and restored with the same inbox and installation, keep the XMTP daemon on Railway.

Cloudflare Containers use ephemeral disks and do not guarantee a fixed runtime. Suppressing idle sleep and adding a watchdog reduces expected downtime; neither turns local disk into durable storage. See the Cloudflare [Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/) and [Container FAQ](https://developers.cloudflare.com/containers/faq/).

## Target architecture

~~~mermaid
flowchart TD
    SMTP["Internet SMTP"] --> ER["Cloudflare Email Routing"]
    ER --> EW["Edge Worker email()"]
    EW --> D1["D1 relay state"]
    EW --> QX["XMTP delivery Queue"]
    QX --> C["Singleton XMTP Container"]
    C <--> XMTP["XMTP network"]
    C --> EW
    EW --> QE["Email delivery Queue"]
    QE --> ES["Cloudflare Email Service"]
    ES --> SMTP
    C <--> R2["R2 verified snapshots"]
    WEB["Browser"] --> ASSETS["Workers Static Assets"]
~~~

The Edge Worker owns external email handling, D1 state, Queue consumers, the native <code>send_email</code> binding, R2 access, authentication, and the Container lifecycle. The Container owns the Node SDK client, the live stream, local XMTP SQLite, catch-up, and safe snapshot orchestration.

### Component boundaries

| Component | Canonical responsibility | Must not own |
|---|---|---|
| <code>xmtp-mx-relay-edge</code> Worker | Email Routing handler, Email Sending, D1, Queue consumers, R2 proxy, lifecycle/watchdog, status | XMTP installation creation during normal production |
| <code>XmtpRelayContainer</code> | Always-on XMTP stream, XMTP sends, local encrypted SDK database, quiesced snapshot and restore | Public unauthenticated privileged APIs, Mailgun |
| D1 <code>xmtp-mx-relay-production</code> | Deduplication, allowlist, thread maps, delivery jobs, retries, status, watchdog pause state | XMTP SDK database |
| R2 <code>xmtp-mx-xmtp-state-production</code> | Immutable signed multipart XMTP parts, pin, and manifests | A live mounted SQLite database, mutable pointer, or freshness authority |
| D1 snapshot anchor | Authoritative monotonic snapshot ID/timestamp/digest behind logical <code>latest.json</code> | Backup contents or HMAC secret |
| Email delivery Queue | Persisted <code>email.send.v1</code> work | Authorization decisions |
| XMTP delivery Queue | Persisted <code>email.inbound.v1</code> and <code>email.send.result.v1</code> work | Durable source of truth |
| Workers Static Assets | Existing Next.js static export | Relay secrets or server-side XMTP |

## Current live-state inventory

These are observations, not desired configuration.

### Source and deployments

| Item | Observed state |
|---|---|
| <code>pierce403/xmtp.mx</code> main | <code>ce7083614e461d9793afa4e89a8c56d3c40d2789</code> |
| <code>pierce403/xmtp.mx-relay</code> main | <code>4a5a134043dff61d1ba2ad3a0c0b88cb2c4c9b00</code> |
| GitHub Pages | [Run 20463955635](https://github.com/pierce403/xmtp.mx/actions/runs/20463955635) succeeded on 2025-12-23 |
| Production hostname | Returns HTTP 200 with <code>server: GitHub.com</code> |
| Vercel | <code>https://xmtp-mx.vercel.app</code> also returns HTTP 200; the repository homepage and commit status still reference Vercel |
| Railway | GitHub deployment <code>3498049231</code> reported success on 2025-12-18; no public relay URL or live logs are available in this workspace |
| Railway image/config | The checked-in root Dockerfile builds Node 20, exposes port 3000, uses <code>DATA_DIR=/data</code>, and starts <code>dist/index.js</code>; no separate Railway service config is checked in |
| Legacy relay | Mailgun SDK/webhook/fake tooling and <code>better-sqlite3</code> remain present for the staged rollback path until the removal gates pass |
| Cloudflare | Local Wrangler is installed but unauthenticated; no Cloudflare account credentials are available |

The frontend Pages workflow currently consumes <code>NEXT_PUBLIC_THIRDWEB_CLIENT_ID</code> and <code>NEXT_PUBLIC_MAINNET_RPC_URL</code>. GitHub does not reveal secret values, so they must be entered again for Cloudflare builds. <code>NEXT_PUBLIC_BASE_PATH</code> must be empty when building for the apex hostname.

### Public DNS

| Name | Type | Observed value |
|---|---|---|
| <code>xmtp.mx</code> | NS | <code>dns1.registrar-servers.com</code>, <code>dns2.registrar-servers.com</code> |
| <code>xmtp.mx</code> | A | <code>185.199.109.153</code>, <code>185.199.110.153</code> |
| <code>xmtp.mx</code> | AAAA | none |
| <code>xmtp.mx</code> | MX | none |
| <code>xmtp.mx</code> | TXT/SPF | none |
| <code>xmtp.mx</code> | CAA | none |
| <code>xmtp.mx</code> | DS | none; DNSSEC delegation was not observed |
| <code>_dmarc.xmtp.mx</code> | TXT | NXDOMAIN |
| <code>www.xmtp.mx</code> | any | NXDOMAIN |
| <code>mail.xmtp.mx</code> | MX | priority 10: <code>mxa.mailgun.org</code>, <code>mxb.mailgun.org</code> |
| <code>mail.xmtp.mx</code> | TXT | <code>v=spf1 include:mailgun.org ~all</code> |
| <code>email.mail.xmtp.mx</code> | CNAME | <code>mailgun.org</code> |
| <code>_dmarc.mail.xmtp.mx</code> | TXT | NXDOMAIN |
| <code>smtp._domainkey.mail.xmtp.mx</code> | TXT | NXDOMAIN at the conventional selector checked; the actual Mailgun selector is unknown |

The Mailgun records are on <code>mail.xmtp.mx</code>, while the repository example says <code>MAILGUN_DOMAIN=xmtp.mx</code>. Confirm the actual Railway and Mailgun dashboard values. The current <code>mail.xmtp.mx</code> records alone are not a rollback route for mail addressed to <code>@xmtp.mx</code>.

### Current production blockers

As of the review timestamp, production deployment and cutover cannot be performed from this workspace because:

- Wrangler reports no authenticated user, and neither <code>CLOUDFLARE_ACCOUNT_ID</code> nor <code>CLOUDFLARE_API_TOKEN</code> is present.
- Workers Paid, Containers, Email Sending arbitrary-recipient access/quota, Email Routing, D1, R2, Queues, and DLQs cannot be inspected or provisioned.
- Registrar/authoritative-DNS access is unavailable; the nameservers are still the registrar's, not Cloudflare's.
- Railway CLI/token/project/volume/log access is unavailable, as are the production bot key, database, pin, expected IDs, and actual Mailgun variables.
- Docker or a compatible local Container builder is unavailable. Wrangler's local dry-run startup was also blocked by this environment's network policy; typechecking and unit tests do not substitute for a bundle/image build.
- No controlled allowlisted/unauthorized XMTP test databases, SMTP injection mailbox, real receiving mailbox, or DMARC report mailbox is configured here.
- The existing production installation has not yet been inspected, snapshotted to R2, destroyed/restored, or compared by network installation count.
- The root domain currently has no working inbound Mailgun route, so an apex inbound rollback must be created or an inbound-pause rollback explicitly accepted before MX cutover.
- Cloudflare Email Service and XMTP delivery do not provide a cross-system transaction or shared idempotency key; the documented <code>uncertain</code> quarantine/reconciliation procedure is an operational requirement, not an optional enhancement.
- The guarded <code>activate-pre-mx</code> job cannot independently observe Railway. <code>CLOUDFLARE_RELAY_LEGACY_LISTENER_STOPPED=true</code> is a protected operator attestation, not a distributed lock; activating while Railway is running would violate the one-listener rule.

GitHub repository write access does not grant any of the Cloudflare, registrar, Railway, Mailgun, XMTP-key, or mailbox authority above. No deployment, DNS mutation, real email send, or production recovery drill was attempted during this review.

## Provisioning gates

Do not begin production work until all boxes are checked:

- [ ] Cloudflare account uses Workers Paid. Containers and arbitrary-recipient Email Sending require it.
- [ ] <code>xmtp.mx</code> is added to that account and the account ID is known.
- [ ] Registrar access and a complete authoritative DNS export are available.
- [ ] Railway project access, production variable access, volume access, and the public health URL are available.
- [ ] The current <code>XMTP_BOT_KEY</code>, expected inbox ID, installation ID, <code>xmtp-inbox-id.txt</code>, encrypted DB, and <code>relay.sqlite</code> are recoverable.
- [ ] A controlled allowlisted XMTP test identity and an unauthorized XMTP test identity exist without consuming the production relay installation.
- [ ] An external SMTP sender and real receiving mailbox are available for header and delivery testing.
- [ ] Workers Paid Email Sending quota is sufficient for arbitrary recipients.
- [ ] Docker or a compatible builder can produce a <code>linux/amd64</code> image, or Workers Builds is configured to build it.
- [ ] A least-privilege Cloudflare API token is available to CI or the operator.
- [ ] The Mailgun apex rollback configuration has been created and tested, or rollback explicitly remains “Railway XMTP only; inbound paused.”

Standard non-runtime deployment variables are:

~~~text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
~~~

Do not store their values in the repository.

## Cloudflare resource inventory

Use separate staging resources and credentials. The following names are production:

| Type | Name | Binding |
|---|---|---|
| Worker | <code>xmtp-mx-relay-edge</code> | Workers.dev enabled; record the exact URL returned by deploy |
| Durable Object class | <code>XmtpRelayContainer</code> | <code>XMTP_RELAY</code> |
| Container instance | <code>xmtp-mx-relay-production</code> | stable ID passed to <code>getContainer</code> |
| Container image | <code>../container/Dockerfile</code> relative to <code>cf-worker/wrangler.toml</code> | <code>linux/amd64</code>, port 8080 |
| D1 | <code>xmtp-mx-relay-production</code> | <code>RELAY_DB</code> |
| R2 | <code>xmtp-mx-xmtp-state-production</code> | <code>XMTP_STATE_BUCKET</code> |
| Queue | <code>xmtp-mx-email-delivery-production</code> | <code>EMAIL_DELIVERY_QUEUE</code> |
| DLQ | <code>xmtp-mx-email-delivery-dlq-production</code> | Queue configuration |
| Queue | <code>xmtp-mx-xmtp-delivery-production</code> | <code>XMTP_DELIVERY_QUEUE</code> |
| DLQ | <code>xmtp-mx-xmtp-delivery-dlq-production</code> | Queue configuration |
| Email Sending | Cloudflare Email Service | <code>EMAIL</code> |
| Frontend staging | <code>xmtp-mx-frontend-staging</code> | Static Assets |
| Frontend production | <code>xmtp-mx-frontend</code> | Static Assets custom domain <code>xmtp.mx</code> |

The Edge Wrangler config enables its stable Workers.dev hostname and defines no zone route or custom domain. Record the exact URL returned by Wrangler in the change record and set it as <code>SMOKE_EDGE_URL</code>; do not assume <code>relay.xmtp.mx</code> exists. Its public surface is minimal health plus bearer-authenticated internal/admin routes. Email Routing targets the Worker by script name and does not depend on the HTTP hostname.

The Container configuration must keep <code>max_instances=1</code> and use the fixed instance ID. Do not use random routing or autoscaling. <code>XmtpRelayContainer</code> sets <code>sleepAfter="24h"</code>, overrides activity expiration to renew the timer instead of stopping, and is checked by the one-minute Cron watchdog. The Cron is lifecycle supervision and durable-outbox recovery; it never polls XMTP. Cloudflare host maintenance and failures can still replace the Container, which is why R2 restore is mandatory.

## Resource provisioning

Run from a trusted operator workstation. Record every returned resource ID in a private change record, then put non-secret IDs into Wrangler configuration.

~~~bash
cd cf-worker
npm ci
npx wrangler login
npx wrangler whoami

npx wrangler d1 create xmtp-mx-relay-production
npx wrangler r2 bucket create xmtp-mx-xmtp-state-production

npx wrangler queues create xmtp-mx-email-delivery-production \
  --message-retention-period-secs 1209600
npx wrangler queues create xmtp-mx-email-delivery-dlq-production \
  --message-retention-period-secs 1209600
npx wrangler queues create xmtp-mx-xmtp-delivery-production \
  --message-retention-period-secs 1209600
npx wrangler queues create xmtp-mx-xmtp-delivery-dlq-production \
  --message-retention-period-secs 1209600
~~~

Update <code>cf-worker/wrangler.toml</code> with the returned D1 database ID. Confirm the production Queue consumers have:

- a DLQ;
- bounded retries;
- <code>max_concurrency=1</code> where ordering or singleton delivery matters;
- the 14-day Paid-plan retention configured above on both primary Queues and DLQs;
- a consumer on each DLQ that upserts one <code>queue_failure</code> record, emits a structured failure log, compare-and-sets only pending work to a terminal state, and leaves active <code>sending</code>/<code>delivering</code> claims for the long-aged watchdog;
- no payloads near the Queue 128 KiB limit.

Apply the schema:

~~~bash
cd cf-worker
npx wrangler d1 migrations apply RELAY_DB --remote --config wrangler.toml
~~~

Inspect, rather than assume, the result:

~~~bash
npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"
~~~

Expected application tables include:

- <code>inbound_email</code>
- <code>outbound_request</code>
- <code>allowlist_xmtp</code>
- <code>thread_map</code>
- <code>delivery_job</code>
- <code>queue_failure</code>
- <code>relay_state</code>
- <code>snapshot_anchor</code>

Build and validate the Worker/Container bundle before any upload:

~~~bash
cd cf-worker
npm run typecheck
npm test
npx wrangler deploy --dry-run --config wrangler.toml
~~~

A dry run does not validate Cloudflare authentication, account entitlement, deployed bindings, DNS, Email Service, or the Container runtime. Stop here until the secrets/configuration, stopped-Railway export, D1 import, and pre-deploy watchdog pause are complete. The runtime fails closed when <code>watchdog_pause</code> is missing or invalid: Cron does not sweep/start, XMTP delivery retries without contacting the Container, and status reports <code>watchdogConfigured=false</code>/<code>watchdogPaused=null</code>. Still seed an explicit paused state before deployment so operator intent is durable and auditable. Only the authenticated start control writes explicit <code>paused:false</code> and activates the listener; Railway must already be stopped and independently verified.

The first controlled upload/deployment commands are in “Existing-production snapshot and R2 seed.” Wrangler then prints the account-specific Workers.dev URL. Record it, require <code>/healthz</code> to return 200, and use exactly that URL for <code>SMOKE_EDGE_URL</code>. Record the Worker version, Container image digest, D1 migration, Queue consumer settings, and R2 bucket in the private change record. This workspace has no authenticated Cloudflare session, so no command in this runbook has uploaded production resources.

The checked-in <code>.github/workflows/cloudflare-relay.yml</code> separates code deployment from listener activation. A push or pull request runs validation only. Both manual actions are main-only, require the exact Container confirmation and protected <code>cloudflare-relay-production</code> environment, and never change DNS/MX.

<code>deploy-paused</code> applies D1 migrations, runs the checked-in pause SQL before deployment, deploys the Edge/Container code, and verifies Edge health while the watchdog remains paused and Container not running. It requires:

~~~text
CLOUDFLARE_RELAY_RESOURCES_PROVISIONED=true
CLOUDFLARE_RELAY_SOURCE_EXPORT_READY=true
CLOUDFLARE_RELAY_PAUSED_DEPLOY_APPROVED=true
~~~

After the stopped-Railway export is uploaded/read back and its D1 anchor is verified, <code>activate-pre-mx</code> calls the authenticated start route and verifies pinned/current/configured inbox and installation identity. It requires:

~~~text
CLOUDFLARE_RELAY_R2_SNAPSHOT_READY=true
CLOUDFLARE_RELAY_LEGACY_LISTENER_STOPPED=true
CLOUDFLARE_RELAY_ACTIVATION_APPROVED=true
~~~

The legacy-listener flag is a protected operator attestation, not a distributed lock. Before activation, separately record that Railway is stopped, its XMTP stream is gone, the final source snapshot and D1 import are reconciled, and configured expected IDs match the inspected source. The workflow does not alter Email Routing, MX, Mailgun, Railway, or the frontend. Its <code>recovery:drill</code> validation step uses synthetic state and is not production F/G evidence.

Configure the protected <code>cloudflare-relay-production</code> GitHub environment with <code>CLOUDFLARE_ACCOUNT_ID</code>, least-privilege <code>CLOUDFLARE_API_TOKEN</code>, and <code>SMOKE_ADMIN_TOKEN</code> secrets plus <code>SMOKE_EDGE_URL</code> and the six gate variables above. <code>SMOKE_ADMIN_TOKEN</code> must equal the deployed Worker's <code>RELAY_ADMIN_TOKEN</code> value without exposing it. Require reviewers and do not store the recovery or signing key in ordinary repository variables.

## Configuration and secrets

### Worker and Container secrets

Set interactively:

~~~bash
cd cf-worker
npx wrangler secret put CONTAINER_SHARED_SECRET --config wrangler.toml
npx wrangler secret put RELAY_ADMIN_TOKEN --config wrangler.toml
npx wrangler secret put RECOVERY_ADMIN_TOKEN --config wrangler.toml
npx wrangler secret put XMTP_BOT_KEY --config wrangler.toml
npx wrangler secret put XMTP_EXPECTED_INBOX_ID --config wrangler.toml
npx wrangler secret put XMTP_EXPECTED_INSTALLATION_ID --config wrangler.toml
npx wrangler secret put XMTP_SNAPSHOT_SIGNING_KEY --config wrangler.toml
~~~

Requirements:

- <code>CONTAINER_SHARED_SECRET</code>, <code>RELAY_ADMIN_TOKEN</code>, and <code>RECOVERY_ADMIN_TOKEN</code> must be unrelated, random, and at least 32 bytes. The recovery token is exposed to an operator process only during a stopped-Container import window.
- The checked-in uploader reads that same recovery-token value from the operator-only environment name <code>CLOUDFLARE_RECOVERY_ADMIN_TOKEN</code>; this name is not a Worker binding and must not be committed.
- <code>XMTP_BOT_KEY</code> must be the existing Railway production key. Rotating it changes identity and is not part of this migration.
- Expected IDs must come from the current installation and verified snapshot, not from a newly constructed client.
- <code>XMTP_SNAPSHOT_SIGNING_KEY</code> is required and must be an independent, high-entropy recovery secret shared with the offline exporter. There is no transport-token fallback. Escrow the signing key in the approved secret manager; do not rotate it without a dual-key/re-sign migration that has been recovery-tested.
- Secrets must exist only in Cloudflare Secrets or Secrets Store and the existing Railway secret store during rollback.
- If <code>ETH_RPC_URL</code> embeds an API key or account identifier, set it as a Cloudflare Secret instead of a Wrangler variable.

### Non-secret variables

~~~text
INBOUND_EMAIL_TO=deanpierce.eth@xmtp.mx
EMAIL_FROM=Dean (XMTP) <deanpierce.eth@xmtp.mx>
XMTP_ALLOWED_SENDERS=<comma-separated inbox IDs used only to seed D1>
XMTP_ENV=production
XMTP_DEAN_ADDRESS=deanpierce.eth
ETH_RPC_URL=<optional HTTPS mainnet RPC>
CONTAINER_INSTANCE_NAME=xmtp-mx-relay-production
XMTP_R2_PREFIX=xmtp-mx-relay-production/xmtp
XMTP_BACKUP_INTERVAL_SECONDS=3600
XMTP_BACKUP_MAX_STALENESS_SECONDS=7200
MAX_INBOUND_EMAIL_BYTES=<chosen limit no greater than platform limit>
MAX_RELAY_BODY_BYTES=<chosen application limit>
MAX_INTERNAL_REQUEST_BYTES=<chosen internal API limit>
MAX_XMTP_BACKUP_BYTES=<greater than current DB plus growth margin>
MAX_XMTP_BACKUP_PART_BYTES=16777216
QUEUE_MAX_RETRIES=<bounded retry count>
QUEUE_REPLAY_STALE_SECONDS=300
QUEUE_ABANDONED_SECONDS=21600
QUEUE_ORPHANED_HANDOFF_SECONDS=86400
RECOVERY_DRILL_ENABLED=false
RECOVERY_IMPORT_ENABLED=false
XMTP_ALLOW_NEW_INSTALLATION=false
LOG_LEVEL=info
~~~

The Worker passes the per-part and free-space values below to the Container. The remaining values are Container image defaults unless explicitly added to Wrangler forwarding; record the effective runtime values either way:

~~~text
# Forwarded by the Worker
XMTP_BACKUP_PART_BYTES=16777216
XMTP_FREE_SPACE_MARGIN_BYTES=67108864

# Container image defaults unless explicitly forwarded
XMTP_CATCHUP_MESSAGES_PER_CONVERSATION=10000
XMTP_REPLAY_OVERLAP_SECONDS=300
XMTP_MAX_BACKUP_BYTES=1073741824
~~~

The production Worker and image default to a 3,600-second snapshot interval and 7,200-second maximum backup age because each consistent snapshot briefly restarts the XMTP child. The per-part request limit defaults to 16 MiB and may never exceed 32 MiB. <code>MAX_XMTP_BACKUP_BYTES</code> is the Worker-side total database budget; it must be equal to or smaller than the Container's <code>XMTP_MAX_BACKUP_BYTES</code>. The restore preflight requires database bytes plus the 64 MiB free-space margin. Changing any of these requires a reviewed code/config change; do not rely on an undocumented dashboard override.

The D1 <code>allowlist_xmtp</code> table is canonical after migration. The environment list is only a seed. Every entry must be a normalized, 64-character lowercase XMTP inbox ID. The Edge Worker intentionally does not resolve ENS names or Ethereum wallet addresses; putting <code>deanpierce.eth</code> or <code>0x...</code> in D1 or <code>XMTP_ALLOWED_SENDERS</code> fails closed.

Allowlist migration gate:

1. While Railway is still healthy, let the existing relay resolve every configured ENS name/address through its current production XMTP client and require startup to succeed.
2. After Railway is gracefully stopped for export, record the resulting inbox IDs from <code>relay.sqlite</code>; do not infer an inbox ID from a wallet address.
3. Verify every source value is lowercase 64-hex:

~~~sql
SELECT sender_inbox_or_address
FROM allowlist_xmtp
WHERE length(sender_inbox_or_address) <> 64
   OR sender_inbox_or_address <> lower(sender_inbox_or_address)
   OR lower(sender_inbox_or_address) GLOB '*[^0-9a-f]*';
~~~

This query must return zero rows. The legacy exporter independently rejects any non-inbox-ID entry. After D1 import, run the same query remotely, compare the complete sorted source and destination lists, and send one controlled message from each authorized inbox plus one unauthorized inbox. A row count alone is not sufficient.

Container defaults and internal endpoints:

~~~text
PORT=8080
DATA_DIR=/data
EDGE_INTERNAL_URL=http://xmtp-edge.internal
R2_INTERNAL_BASE_URL=http://xmtp-r2.internal
~~~

The virtual hosts exist only through Container outbound handlers. The R2 handler accepts authenticated <code>GET</code>/<code>PUT</code> requests under <code>/v1/objects/:encodedKey</code>. It enforces content length, SHA-256, per-object size, and create-only writes for every non-<code>latest.json</code> object regardless of caller behavior; such PUTs must include <code>If-None-Match: *</code>. It also enforces signed-v2 validation for <code>latest.json</code> and the D1 freshness anchor. The Edge handler accepts authenticated <code>POST /internal/v1/xmtp/events</code>.

## Interface and authentication

Public:

- <code>GET /healthz</code>: minimal Edge health; no secrets or detailed topology.

Admin Bearer token:

- <code>GET /internal/v1/status</code>
- <code>POST /internal/v1/container/stop</code>
- <code>POST /internal/v1/container/start</code>
- <code>POST /internal/v1/container/restart</code>
- <code>POST /internal/v1/container/recreate</code>
- <code>POST /internal/v1/container/backup</code>

Independent recovery Bearer token, disabled unless <code>RECOVERY_IMPORT_ENABLED=true</code>:

- <code>GET|PUT /internal/v1/admin/recovery/objects/:encodedKey</code>

Container shared secret:

- Edge receives <code>POST /internal/v1/xmtp/events</code>.
- Container receives <code>POST /internal/v1/xmtp/deliver</code>.
- R2 proxy receives object <code>GET</code>/<code>PUT</code>.
- Container exposes <code>GET /internal/v1/status</code> and <code>POST /internal/v1/admin/backup</code> only with the shared secret.

Container liveness:

- <code>GET /livez</code>: always-200 process liveness used by the Cloudflare Container ping; this keeps a fail-closed recovery-required hold inspectable without a restart loop.
- <code>GET /healthz</code>: 503 for a terminal fatal/recovery-required state.
- <code>GET /readyz</code>: 200 only while the verified XMTP stream is ready.

Non-recovery startup, backup, and failed child-restart errors terminate the
Container process with a nonzero status after graceful child shutdown so the
platform can restart it. A <code>recovery_required</code> identity or snapshot
failure never enters that loop: it stops the XMTP child, emits the explicit
recovery alert, and waits for an operator.

Do not route Container port 8080 directly to the Internet. A Worker-to-Container call via the Durable Object binding is the privileged boundary.

Stopping requires the exact body:

~~~json
{"confirm":"xmtp-mx-relay-production","pauseWatchdog":true}
~~~

The Worker must persist the paused-watchdog state in D1 before stopping. Cron must honor it. A missing/invalid pause record is fail-closed, not permission to start. Starting requires the same instance-name confirmation and writes explicit <code>paused:false</code> only as part of an operator action.

Operator calls, with <code>RELAY_ADMIN_TOKEN</code> loaded from the secret manager into the process environment:

~~~bash
RELAY_EDGE_URL='REPLACE_WITH_EXACT_DEPLOYED_WORKERS_DEV_URL'

curl --fail-with-body \
  --header "Authorization: Bearer $RELAY_ADMIN_TOKEN" \
  "$RELAY_EDGE_URL/internal/v1/status"

curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $RELAY_ADMIN_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"confirm":"xmtp-mx-relay-production","reason":"operator-checkpoint"}' \
  "$RELAY_EDGE_URL/internal/v1/container/backup"

curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $RELAY_ADMIN_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"confirm":"xmtp-mx-relay-production","pauseWatchdog":true}' \
  "$RELAY_EDGE_URL/internal/v1/container/stop"

curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $RELAY_ADMIN_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"confirm":"xmtp-mx-relay-production"}' \
  "$RELAY_EDGE_URL/internal/v1/container/start"
~~~

Restart and recreate are destructive recovery-test operations. They require:

- Admin Bearer authentication;
- <code>RECOVERY_DRILL_ENABLED=true</code>;
- the exact <code>xmtp-mx-relay-production</code> confirmation;
- an <code>expectedInboxId</code> equal to the configured production inbox ID.

~~~json
{
  "confirm": "xmtp-mx-relay-production",
  "expectedInboxId": "REPLACE_WITH_CONFIGURED_64_HEX_INBOX_ID"
}
~~~

Return <code>RECOVERY_DRILL_ENABLED</code> to <code>false</code> after the drill.

The recovery object route is for a stopped Railway snapshot import, including a newer final snapshot after an earlier drill. It additionally requires a durably paused watchdog and the stable Container state exactly <code>stopped</code>. Every PUT requires <code>x-recovery-confirm: xmtp-mx-relay-production</code>. Keep <code>RECOVERY_IMPORT_ENABLED=false</code> at all other times, and never reuse <code>RELAY_ADMIN_TOKEN</code> or <code>CONTAINER_SHARED_SECRET</code> as <code>RECOVERY_ADMIN_TOKEN</code>.

## D1 idempotency model

Cloudflare Queues are at least once. D1 unique keys make ordinary duplicates safe:

| Event | Unique key |
|---|---|
| Inbound SMTP | Deterministic inbound dedupe digest |
| Outbound XMTP request | XMTP message ID |
| XMTP delivery | Stable <code>delivery_job.job_id</code> |
| Allowlist member | Normalized 64-hex XMTP inbox ID primary key |
| Thread map | RFC message ID |

Queue publication and D1 mutation are not a cross-service transaction. Persist the row/job first, publish a pointer, then mark the confirmed handoff as <code>queued</code>. The short-gap sweeper reconstructs missing jobs and republishes only stale <code>received</code> rows. It deliberately leaves <code>queued</code>/<code>retrying</code> to Cloudflare Queues so it cannot reset broker retry/DLQ attempt budgets. A separate six-hour watchdog compare-and-sets abandoned <code>sending</code>/<code>delivering</code> claims to <code>uncertain</code> without repeating an external send. Because each DLQ itself has finite retries, a distinct 24-hour orphan horizon republishes only safe <code>queued</code>/<code>retrying</code> pointers after the complete primary-plus-DLQ window; it refreshes the timestamp only after Queue accepts the pointer and only if the predecessor status still matches.

### Exactly-once limitation

Cloudflare Email Service does not expose an idempotency key. A crash after <code>EMAIL.send()</code> accepts a message but before D1 records the returned ID is ambiguous. Blind retry can duplicate mail; refusing to retry can lose it. The same boundary exists after an XMTP send and before its D1 completion update.

Use <code>uncertain</code> for this state and record the stable request/job identifier in logs and provider headers where allowed. A duplicate that sees an active <code>sending</code>/<code>delivering</code> claim defers to that owner; only the long-aged watchdog quarantines an abandoned claim. An accepted-but-unrecorded Email Service or XMTP result is held for manual reconciliation; neither the Queue consumer nor the watchdog may blindly retry it. Treat Email Service <code>E_DELIVERY_FAILED</code> as ambiguous because SMTP delivery or a multi-recipient partial outcome is not proven pre-accept and there is no provider idempotency key. Reconciliation means correlating D1, structured Worker/Container logs, the Cloudflare provider message ID or destination headers where available, and the XMTP conversation/message history, then recording an operator disposition. Acceptance tests D and E prove normal duplicate/replay suppression; they do not prove atomic exactly-once behavior across two independent services during an arbitrary crash.

An <code>email.send.result.v1</code> with <code>error="delivery_state_unknown"</code> means delivery is ambiguous, not conclusively failed. Clients and operators must not resubmit it automatically with a new XMTP message ID.

## Migrating legacy <code>relay.sqlite</code> to D1

Run the import only after Railway is quiesced. Never copy its live WAL database.

1. Stop new inbound Mailgun delivery or point the route at a holding destination.
2. Gracefully stop the Railway process.
3. Confirm no process has <code>/data/relay.sqlite</code> open.
4. Run the checked-in read-only exporter against the stopped volume:

~~~bash
python3 cf-worker/scripts/export_legacy_d1.py /data/relay.sqlite \
  > /tmp/xmtp-mx-relay-import.sql
~~~

5. Inspect the generated SQL for row counts and unexpected values.
6. Import:

~~~bash
cd cf-worker
npx wrangler d1 execute RELAY_DB --remote \
  --file /tmp/xmtp-mx-relay-import.sql \
  --config wrangler.toml
~~~

7. Compare source and destination counts and unique keys:

~~~bash
npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --command "SELECT 'inbound_email' AS table_name, COUNT(*) AS rows FROM inbound_email UNION ALL SELECT 'outbound_request', COUNT(*) FROM outbound_request UNION ALL SELECT 'allowlist_xmtp', COUNT(*) FROM allowlist_xmtp UNION ALL SELECT 'thread_map', COUNT(*) FROM thread_map"
~~~

The importer preserves old outbound rows as dedupe tombstones. Legacy rows do not contain a usable XMTP conversation ID, so they use <code>legacy:unknown</code> and must never be re-driven. Legacy <code>sending</code> rows map to <code>uncertain</code>; reconcile them manually before cutover.

The generated SQL intentionally omits explicit <code>BEGIN TRANSACTION</code>/<code>COMMIT</code>; remote D1 manages file execution and [requires those dump wrappers to be removed](https://developers.cloudflare.com/d1/best-practices/import-export-data/). Every insert is idempotent, so a failed import may be rerun only after inspecting the failure and the partial destination.

The import is a production blocker until source/destination counts, inbound dedupe keys, outbound XMTP message IDs, allowlist members, and thread maps have been compared.

## XMTP snapshot format

R2 prefix:

~~~text
xmtp-mx-relay-production/xmtp/
~~~

Each snapshot has an immutable UUID prefix:

~~~text
snapshots/<snapshot-id>/
  database/
    part-000000-<part-sha256>.bin
    part-000001-<part-sha256>.bin
    ...
  xmtp-inbox-id.txt
  manifest.json

# Export/uploader publication request; Worker anchors the identical immutable
# manifest in D1 instead of trusting a mutable R2 object.
latest.json
~~~

The immutable R2 <code>manifest.json</code> and the export's logical <code>latest.json</code> publication request contain the same canonical signed-v2 document:

~~~json
{
  "version": 2,
  "snapshotId": "<uuid>",
  "createdAt": "<ISO-8601 UTC>",
  "xmtpEnv": "production",
  "inboxId": "<64-hex inbox ID>",
  "installationId": "<installation ID>",
  "database": {
    "sha256": "<whole-database SHA-256>",
    "bytes": 123456789,
    "partSizeBytes": 16777216,
    "parts": [
      {
        "index": 0,
        "offset": 0,
        "key": "<prefix>/snapshots/<uuid>/database/part-000000-<part-sha256>.bin",
        "sha256": "<part SHA-256>",
        "bytes": 16777216
      }
    ]
  },
  "pinnedInbox": {
    "key": "<prefix>/snapshots/<uuid>/xmtp-inbox-id.txt",
    "sha256": "<pin SHA-256>",
    "bytes": 65
  },
  "sourceBootId": "<boot ID>",
  "sourceDeploymentId": null,
  "reason": "<snapshot reason>",
  "replayAfter": "<ISO-8601 UTC>",
  "replayWatermark": null,
  "signature": {
    "algorithm": "hmac-sha256",
    "value": "<64-hex HMAC>"
  }
}
~~~

The HMAC input is the domain-separation bytes <code>xmtp.mx/xmtp-snapshot-manifest/v2\0</code> followed by recursive lexicographic-key canonical JSON for the complete manifest with <code>signature</code> omitted. The signing key is independent from transport/admin tokens and must be at least 32 bytes. Runtime recovery accepts signed v2 only; convert a stopped legacy database with <code>snapshot:export</code> rather than enabling an unsigned compatibility mode.

The manifest binds every part's index, offset, key, SHA-256, and byte count; the database's whole-file SHA-256/bytes/part size; the pin; environment; inbox; installation; source; and replay boundary. Restore requires contiguous ordered parts with content-addressed keys, verifies every part and the concatenated database, and checks free space for the database plus the configured margin before writing.

<code>latest.json</code> is the logical publication request, but a mutable R2 key and a valid HMAC do not by themselves prove freshness. D1 therefore stores the authoritative monotonic anchor. Publication first proves the byte-identical immutable manifest, then advances only D1; steady-state backup code does not overwrite a mutable R2 latest object. A restore reads and revalidates the exact anchored immutable manifest and fails closed on a mismatch, stale pointer, missing anchor, invalid signature, unavailable anchor state, or missing immutable object.

### Snapshot algorithm

1. Mark the runtime backing up and stop accepting new Container deliveries.
2. Wait for any in-flight delivery, ask the XMTP child to shut down, and wait for process exit.
3. Confirm no non-empty <code>-wal</code>, <code>-shm</code>, or <code>-journal</code> remains.
4. Verify the closed database is nonempty, within the total-size budget, and the local filesystem has the configured safety margin.
5. Read the closed database in bounded parts. For each part, compute its SHA-256, use the digest in its immutable key, upload with exact length/hash and create-only semantics, then read it back and verify size/hash.
6. Compute the whole-database SHA-256 while reading and confirm the source inode/size/timestamps and sidecar state did not change.
7. Upload/read-back the immutable pinned-inbox object.
8. Build and sign the canonical v2 manifest. Upload/read-back the immutable manifest.
9. Publish the logical <code>latest.json</code> request through the Worker. It proves the immutable manifest first, then advances the D1 freshness anchor without writing a mutable R2 pointer.
10. Read the anchored pointer back and require the exact signed manifest digest/snapshot ID.
11. Restart the child and verify pinned, configured, and current inbox and installation IDs before reporting ready.
12. Catch up from the snapshot boundary; D1 deduplication absorbs overlap.

The Node SDK does not expose a reliable <code>close()</code> method for this purpose. The Container therefore isolates XMTP in a child process and uses child exit as the exclusive-writer boundary. This briefly pauses the stream at each backup.

## Existing-production snapshot and R2 seed

This is the required path for xmtp.mx. It is not the “create a new installation” bootstrap.

1. First deploy the additive legacy diagnostic that includes <code>installationId: xmtp.installationId</code> in the existing <code>xmtp.ready</code> structured log. It must run against the existing Railway volume with <code>DATA_DIR=/data</code> and <code>XMTP_ALLOW_NEW_INSTALLATION=false</code>. Confirm the log's inbox ID matches <code>/data/xmtp-inbox-id.txt</code> and the existing DB filename, then record the installation ID. Do not guess it and do not derive it from the wallet.
2. Record from Railway:
   - deployment ID;
   - public health URL and last healthy time;
   - <code>XMTP_ENV</code>;
   - bot wallet address;
   - current inbox ID;
   - current installation ID;
   - network installation count;
   - SHA-256 and size of <code>xmtp-inbox-id.txt</code> and the encrypted DB.
3. Pause Mailgun input and stop Railway gracefully.
4. Confirm only one XMTP database exists and its filename agrees with <code>xmtp-inbox-id.txt</code>.
5. Independently inspect the stopped database. Supply the existing bot key to the process from the operator's secret manager; do not put it in the command line, shell history, or a file in the repository:

~~~bash
cd container
npm ci

npm run identity:inspect -- \
  --data-dir /path/to/stopped-railway-data \
  --xmtp-env production \
  --confirm-relay-stopped yes
~~~

The tool requires the pin and DB, rejects nonempty WAL/SHM/journal sidecars, opens the existing database with <code>disableAutoRegister: true</code>, checks wallet/network/pin identity and <code>isRegistered</code>, prints the inbox and installation IDs, and exits before export. It never calls <code>register()</code>. Require its IDs to match the live diagnostic record from steps 1–2.
6. Refuse the snapshot if any sidecar is nonempty or the inspector fails.
7. Use a new, private output directory on a trusted operator host. Substitute the recorded values, then run the offline snapshot tool against the stopped volume:

~~~bash
cd container
npm ci

RELAY_STOPPED_DATA_DIR=/path/to/stopped-railway-data
RELAY_EXPORT_DIR=/safe/new-xmtp-mx-r2-export
RELAY_INBOX_ID='REPLACE_WITH_RECORDED_64_HEX_INBOX_ID'
RELAY_INSTALLATION_ID='REPLACE_WITH_RECORDED_CURRENT_INSTALLATION_ID'

# XMTP_SNAPSHOT_SIGNING_KEY must already be loaded into this process by the
# approved secret manager. Do not type the value into shell history.
test -n "$XMTP_SNAPSHOT_SIGNING_KEY"

npm run snapshot:export -- \
  --data-dir "$RELAY_STOPPED_DATA_DIR" \
  --output-dir "$RELAY_EXPORT_DIR" \
  --xmtp-env production \
  --inbox-id "$RELAY_INBOX_ID" \
  --installation-id "$RELAY_INSTALLATION_ID" \
  --prefix xmtp-mx-relay-production/xmtp \
  --part-bytes 16777216 \
  --max-backup-bytes 1073741824 \
  --replay-after 1970-01-01T00:00:00.000Z
~~~

The exporter requires a signing key of at least 32 bytes, refuses unsafe/oversize state, writes only signed-v2 multipart output, and prints the snapshot ID, identity, database hash/bytes, part count/size, and replay boundary. The epoch replay cutoff is intentionally conservative. Import and verify legacy D1 dedupe state before starting the Container so catch-up cannot resend already-processed outbound requests.

8. Run the protected <code>deploy-paused</code> action for the first Edge deployment; it applies the checked-in pause SQL before deploying and proves that the listener stayed stopped. Before any recovery-enabled deployment, rerun/verify that durable pause, then build a same-directory temporary complete Wrangler config with only the recovery gate enabled. Keeping the temporary file beside <code>wrangler.toml</code> preserves its relative main, migration, and Dockerfile paths:

~~~bash
cd cf-worker

npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --file scripts/pause-watchdog.sql

npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --command "SELECT key,value,updated_at FROM relay_state WHERE key='watchdog_pause';"

RELAY_RECOVERY_CONFIG="$(mktemp ./wrangler.recovery.XXXXXX.toml)"
sed 's/^RECOVERY_IMPORT_ENABLED = "false"$/RECOVERY_IMPORT_ENABLED = "true"/' \
  wrangler.toml > "$RELAY_RECOVERY_CONFIG"
rg -x 'RECOVERY_IMPORT_ENABLED = "true"' "$RELAY_RECOVERY_CONFIG"
npx wrangler deploy --config "$RELAY_RECOVERY_CONFIG"
rm -- "$RELAY_RECOVERY_CONFIG"
~~~

Require the D1 query to show JSON <code>paused:true</code>. Load <code>RELAY_ADMIN_TOKEN</code> from the secret manager, call the authenticated Edge status route, and require <code>watchdogPaused=true</code> plus stable Container state exactly <code>stopped</code> through two Cron intervals. If the Container is running, use the authenticated stop request with <code>pauseWatchdog:true</code> and recheck; Railway must remain stopped throughout. The recovery route is additionally protected by the independent <code>RECOVERY_ADMIN_TOKEN</code>, exact production confirmation, paused-watchdog check, and stopped-Container check. Do not use direct Wrangler R2 upload; it bypasses the monotonic D1 publication contract.
9. Load the recovery and signing tokens from the approved secret manager into the operator process, then use the checked-in uploader:

~~~bash
cd container
npm ci

RELAY_EDGE_URL='REPLACE_WITH_EXACT_DEPLOYED_WORKERS_DEV_URL'

test -n "$CLOUDFLARE_RECOVERY_ADMIN_TOKEN"
test -n "$XMTP_SNAPSHOT_SIGNING_KEY"

npm run snapshot:upload -- \
  --input-dir "$RELAY_EXPORT_DIR" \
  --edge-url "$RELAY_EDGE_URL" \
  --confirm xmtp-mx-relay-production \
  --max-backup-bytes 1073741824
~~~

The uploader validates the signed manifest/layout, every local object, every part, and the concatenated database before network I/O. It PUTs every immutable part, pin, and manifest with exact length/SHA-256 plus <code>If-None-Match: *</code>, GETs and verifies each, then publishes <code>latest.json</code> last. The latest request verifies byte identity with the immutable manifest and atomically advances the D1 monotonic anchor; no mutable R2 pointer is trusted afterward. This path also supports a strictly newer final Railway export after an earlier drill. A stale/equal-different import returns 409.

10. Compare the uploader's snapshot ID, identity, database bytes/parts, and object count with the export receipt. Verify the D1 anchor independently:

~~~bash
cd cf-worker
npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --command "SELECT object_key, snapshot_id, created_at, sha256, updated_at FROM snapshot_anchor WHERE object_key = 'xmtp-mx-relay-production/xmtp/latest.json'"
~~~

Require exactly one matching anchor row. A successful PUT without the uploader's full read-back and matching anchor is not a valid seed.
11. Immediately redeploy the checked-in canonical Worker configuration, whose <code>RECOVERY_IMPORT_ENABLED=false</code> closes the import route:

~~~bash
cd cf-worker
npx wrangler deploy --config wrangler.toml
~~~

Verify authenticated status and confirm a recovery-object request now returns 403. Set <code>XMTP_EXPECTED_INBOX_ID</code> and <code>XMTP_EXPECTED_INSTALLATION_ID</code> from the verified manifest.
12. Keep <code>XMTP_ALLOW_NEW_INSTALLATION=false</code>. The restored child uses <code>disableAutoRegister: true</code> and requires the existing local installation to report registered before it will sync or stream.
13. Do not restart Railway and Cloudflare together. Either continue the handoff or stop Cloudflare before returning to Railway.

If the offline tool or R2 upload cannot be completed while the Railway database is demonstrably quiescent, resume Railway and stop the migration.

## Brand-new installation bootstrap

This procedure is documented for a genuinely new deployment only. It must not be used to migrate the existing xmtp.mx production identity.

Temporarily set:

~~~text
XMTP_ALLOW_NEW_INSTALLATION=true
XMTP_BOOTSTRAP_CONFIRM=I_UNDERSTAND_THIS_REGISTERS_A_NEW_XMTP_INSTALLATION
~~~

Then:

1. Start exactly one Container. Before constructing the new client it must atomically create and read back <code>bootstrap-attempt.json</code> in R2 with a create-only precondition. An existing or concurrently claimed marker is a permanent hard stop; do not delete the marker to retry.
2. Record its inbox and installation IDs.
3. Trigger and verify a quiesced backup immediately.
4. Set expected inbox and installation IDs.
5. Reset <code>XMTP_ALLOW_NEW_INSTALLATION=false</code>.
6. Remove <code>XMTP_BOOTSTRAP_CONFIRM</code>.
7. Redeploy and recreate the filesystem from R2.
8. Confirm the installation count did not increase.

Failure to complete steps 3–8 means the bootstrap is not accepted.

## Recovery drill

Do this before MX or production listener cutover, during a maintenance window in which Railway is stopped.

Capture the authoritative network installation count immediately before and after each drill from the operator host with Container dependencies installed:

~~~bash
cd container
node --input-type=module --eval '
import { Client } from "@xmtp/node-sdk";
const inboxId = process.argv[1];
const [state] = await Client.inboxStateFromInboxIds([inboxId], "production");
if (!state) throw new Error(`No XMTP state for ${inboxId}`);
process.stdout.write(`${JSON.stringify({ inboxId, installationCount: state.installations.length })}\n`);
' "$RELAY_INBOX_ID"
~~~

Retain both JSON outputs with the smoke-test receipt. The count and the current installation ID must both remain unchanged.

### Restart drill

1. Record the internal status, snapshot ID, inbox ID, installation ID, and network installation count.
2. Require a fresh backup inside the configured staleness window.
3. Enable the recovery drill flag.
4. Run:

~~~bash
node scripts/cloudflare-smoke.mjs \
  --suite recovery \
  --confirm xmtp-mx-relay-production
~~~

5. Confirm readiness returns.
6. Compare all recorded IDs and installation count.
7. Send and receive a controlled XMTP message.

### Destroyed-filesystem drill

1. Confirm the D1 logical-latest anchor, its immutable signed manifest, and every referenced R2 object by SHA-256.
2. Invoke the authenticated recreate operation with exact confirmation.
3. Confirm the new filesystem reports <code>mode=restored</code> before any XMTP client construction.
4. Confirm inbox ID and installation ID match the manifest.
5. Confirm the network installation count is unchanged.
6. Confirm the stream catches up and D1 prevents replay.
7. Force another backup and verify its new immutable generation.
8. Return <code>RECOVERY_DRILL_ENABLED=false</code>.

Any mismatch, new installation, missing backup, stale backup, partial restore, or <code>recovery_required</code> event fails the drill. Stop Cloudflare and retain Railway.

## No-dual-listener production handoff

Use a written maintenance window and one operator in control.

1. Verify Cloudflare resources, staging tests, D1 schema, Email Sending test, and initial R2 seed.
2. Pause the Cloudflare watchdog and stop the production Container. Verify internal status says stopped.
3. Keep Railway running while taking no destructive Cloudflare action.
4. Announce the maintenance window and pause inbound Mailgun delivery.
5. Gracefully stop Railway. Verify the process and XMTP stream are gone.
6. Take the final quiesced XMTP snapshot and run <code>snapshot:upload</code> through the temporarily enabled, paused/stopped recovery route. Require a strictly newer D1 anchor.
7. Export final <code>relay.sqlite</code> and import/verify it in D1.
8. Record a handoff receipt:
   - UTC timestamp;
   - Railway deployment and volume identifiers;
   - final R2 snapshot UUID and hashes;
   - source/D1 row counts;
   - inbox ID;
   - installation ID;
   - installation count.
9. Set the protected activation gates from the verified receipt, then run <code>activate-pre-mx</code> to start the fixed Cloudflare instance and clear the watchdog pause.
10. Poll the authenticated Edge <code>/internal/v1/status</code> until <code>container.relay.ready=true</code>, then verify identity, anchor, and backup status. Container <code>/readyz</code> remains private and is checked through the binding/watchdog.
11. Resume the two primary Queue deliveries, one direction at a time, and verify no unexpected backlog is released.
12. Run controlled XMTP outbound and Worker-to-XMTP inbound tests before changing MX.
13. Keep Railway stopped, not deleted.

At no point may both services consume production XMTP.

## Cloudflare Email Sending

Cloudflare [Email Sending](https://developers.cloudflare.com/email-service/) is currently a Public Beta; its [pricing and limits](https://developers.cloudflare.com/email-service/platform/pricing/) require Workers Paid for arbitrary recipients. Confirm the account quota and suppression state before cutover.

Configure the native binding with an allowed sender:

~~~toml
[[send_email]]
name = "EMAIL"
allowed_sender_addresses = ["deanpierce.eth@xmtp.mx"]
~~~

The Worker must preserve <code>to</code>, <code>cc</code>, <code>bcc</code>, <code>subject</code>, <code>text</code>, <code>html</code>, and <code>replyTo</code>, while forcing <code>from</code> to <code>EMAIL_FROM</code>.

The v1 result field remains named <code>mailgunId</code> for wire compatibility. With Cloudflare it contains the Cloudflare provider message ID.

Test first to an account-verified destination, then to an arbitrary controlled destination. A successful binding call means Cloudflare accepted the message; use Email Service logs/events and the destination mailbox to prove final delivery.

## Cloudflare Email Routing

Cloudflare Email Routing requires the domain to use Cloudflare authoritative DNS.

The <code>email()</code> handler must:

1. Enforce the configured recipient and size limit.
2. Parse RFC 5322/MIME with <code>postal-mime</code>.
3. Compute a deterministic dedupe key that does not trust <code>Message-ID</code> alone.
4. Insert D1 state before acknowledging work.
5. Publish only a small Queue job pointer.
6. Return quickly.
7. Let the Queue consumer deliver <code>email.inbound.v1</code> through the authenticated Container interface.

Email Routing accepts messages larger than D1 row and Queue message limits. Keep the application limit explicit. If raw MIME or attachments are later supported, put raw content in R2 and queue an object pointer; do not put a 25 MiB email in D1 or a Queue message.

Configure an exact test alias before a catch-all. Route <code>deanpierce.eth@xmtp.mx</code> only after the Worker, D1, Queue, Container, and dedupe tests pass.

## DNS and nameserver migration

### Delegate to Cloudflare without moving web or MX

1. At least one existing TTL before the window, record all TTLs and lower only the web/mail records that will change to a rollback-friendly value. Restore normal TTLs after the observation window.
2. Export the complete current DNS zone from the registrar/DNS provider.
3. Add <code>xmtp.mx</code> to Cloudflare.
4. Recreate every record, including the GitHub Pages apex A records and Mailgun <code>mail</code> subdomain records.
5. Do not add the production frontend Custom Domain or root Email Routing MX yet.
6. Change registrar nameservers to the exact Cloudflare-assigned pair.
7. Verify delegation from multiple resolvers.
8. Verify <code>https://xmtp.mx</code> still serves GitHub Pages.
9. Verify <code>mail.xmtp.mx</code> MX/SPF/tracking records are unchanged.

This separates DNS-provider migration from application cutover.

No DS record was observed. Do not introduce DNSSEC during the nameserver/application cutover. After the Cloudflare zone and mail/web paths are stable, enable DNSSEC in a separate change, publish the exact Cloudflare-provided DS at the registrar, and verify validation before closing that change.

### Email Service records

Use the exact records and priorities generated by the Cloudflare dashboard. Do not paste example DKIM values.

Expected categories:

~~~text
# Inbound Email Routing at apex
MX   xmtp.mx                         route1.mx.cloudflare.net
MX   xmtp.mx                         route2.mx.cloudflare.net
MX   xmtp.mx                         route3.mx.cloudflare.net
TXT  xmtp.mx                         one SPF record including Cloudflare
TXT  <routing-selector>._domainkey   Cloudflare routing DKIM

# Outbound Email Sending/bounces
MX   cf-bounce.xmtp.mx               Cloudflare-generated bounce MX values
TXT  cf-bounce.xmtp.mx               Cloudflare-generated SPF
TXT  <sending-selector>._domainkey   Cloudflare sending DKIM

# DMARC, monitoring first
TXT  _dmarc.xmtp.mx                  v=DMARC1; p=none; rua=mailto:<verified-report-address>
~~~

Rules:

- Publish one SPF TXT record per name; merge includes during rollback overlap.
- Do not mix Mailgun and Cloudflare MX as a traffic-splitting strategy. Different priorities are failover behavior and can produce inconsistent delivery.
- Confirm the DMARC report address can actually receive reports.
- Start DMARC at <code>p=none</code>, inspect legitimate alignment, then move to <code>quarantine</code> and <code>reject</code> in later changes.
- Remove Mailgun authentication records only after the rollback window.

Verification:

~~~bash
dig NS xmtp.mx
dig MX xmtp.mx
dig TXT xmtp.mx
dig MX cf-bounce.xmtp.mx
dig TXT cf-bounce.xmtp.mx
dig TXT REPLACE_WITH_ROUTING_SELECTOR._domainkey.xmtp.mx
dig TXT REPLACE_WITH_SENDING_SELECTOR._domainkey.xmtp.mx
dig TXT _dmarc.xmtp.mx
~~~

DNS presence is not sufficient. Inspect a real recipient’s <code>Authentication-Results</code> for SPF pass, DKIM pass, DMARC pass, and alignment with the visible From domain.

## Frontend migration

The existing Next application remains a static export served by [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

Build variables:

~~~text
NEXT_PUBLIC_BASE_PATH=
NEXT_PUBLIC_THIRDWEB_CLIENT_ID=<re-enter value>
NEXT_PUBLIC_MAINNET_RPC_URL=<optional; remember it is embedded in public JavaScript>
NEXT_PUBLIC_XMTP_ENV=production
~~~

Staging:

~~~bash
cd ../xmtp.mx
npm ci
NEXT_PUBLIC_BASE_PATH= npm run build
npm run cloudflare:dry-run:staging
npm run cloudflare:deploy:staging
~~~

Validate the production candidate and the one-time trigger configuration without uploading:

~~~bash
npm run cloudflare:dry-run:production-candidate
npm run cloudflare:dry-run:production
~~~

The production identity has two configurations with deliberately different roles:

- <code>wrangler.production-preview.jsonc</code> uses the route-free <code>xmtp-mx-frontend</code> identity. It is used once to bootstrap the Worker and thereafter only by <code>wrangler versions upload</code>/<code>versions deploy</code>.
- <code>wrangler.production.jsonc</code> uses the same <code>xmtp-mx-frontend</code> identity plus Custom Domain <code>xmtp.mx</code>. It is used only by <code>wrangler triggers deploy</code> for the initial domain attachment.

After staging passes, use the protected <code>Deploy frontend to Cloudflare</code> workflow from <code>main</code>:

1. Run <code>target=production-bootstrap</code> once, before the Custom Domain exists. It creates the route-free production Worker and verifies its exact commit at the configured Workers.dev URL.
2. Run <code>target=cutover</code>. The workflow uploads an immutable candidate using <code>wrangler versions upload</code>, assigns a unique preview alias, verifies that exact candidate, waits for production approval, promotes the exact tested tag to 100% with <code>wrangler versions deploy</code>, and only then runs <code>wrangler triggers deploy</code> to attach <code>xmtp.mx</code>.
3. After cutover, use <code>target=production-release</code> for later releases. A full <code>wrangler deploy</code> to the production identity after the Custom Domain exists is forbidden because it bypasses exact-version preview and promotion.

The local scripts below are operator primitives, not a substitute for the protected workflow:

~~~bash
npm run cloudflare:bootstrap:production  # exactly once, before cutover
npm run cloudflare:upload:production     # upload candidate only
npm run cloudflare:cutover:production    # attach trigger only after exact-version promotion
~~~

Expected projects:

- <code>wrangler.jsonc</code>: <code>xmtp-mx-frontend-staging</code>, Workers.dev and preview URLs enabled, no custom route.
- <code>wrangler.production-preview.jsonc</code>: route-free <code>xmtp-mx-frontend</code>, Workers.dev and version preview URLs enabled.
- <code>wrangler.production.jsonc</code>: the same <code>xmtp-mx-frontend</code> identity with Custom Domain exactly <code>xmtp.mx</code>.
- Static assets: <code>./out</code>, <code>not_found_handling=404-page</code>, <code>html_handling=auto-trailing-slash</code>.

The production Custom Domain may require removing a conflicting apex web record. Do not touch MX when changing the web hostname.

GitHub environments and token scopes:

| Environment | Purpose | Maximum Cloudflare token scope |
|---|---|---|
| <code>cloudflare-staging</code> | Safe staging Worker | Account Workers Scripts Edit; no Zone, Route, Custom Domain, or DNS permission |
| <code>cloudflare-production-preview</code> | One-time bootstrap and immutable candidate upload on Workers.dev | Account Workers Scripts Edit; no Zone, Route, Custom Domain, or DNS permission |
| <code>cloudflare-production</code> | Exact-version promotion and initial apex trigger | Account Workers Scripts Edit plus Zone Workers Routes Edit, scoped only to <code>xmtp.mx</code> |

Keep required reviewers on <code>cloudflare-production</code>. Production-preview and cutover jobs must reject refs other than <code>refs/heads/main</code>. Required workflow secrets are:

~~~text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
NEXT_PUBLIC_THIRDWEB_CLIENT_ID
~~~

<code>NEXT_PUBLIC_MAINNET_RPC_URL</code> is optional/recommended and is embedded in public browser JavaScript when supplied.

Set <code>CLOUDFLARE_FRONTEND_SMOKE_URL</code> in staging and production-preview to the exact Workers.dev URL. Set <code>CLOUDFLARE_WORKERS_SUBDOMAIN</code> in production-preview so the workflow can construct the immutable candidate alias. Keep <code>CLOUDFLARE_FRONTEND_CUTOVER_COMPLETE=false</code> in both production environments until the live cutover passes; then set both to <code>true</code>. The cutover job always checks <code>https://xmtp.mx</code>. A post-deploy check must require the stamped commit, expected <code>&lt;title&gt;xmtp.mx&lt;/title&gt;</code>, a <code>Server: cloudflare</code> response header, <code>/favicon.ico</code> returning 200, static assets, and exported 404 behavior, with bounded retries.

Automatic production deploy remains off until the repository variable below is explicitly enabled after successful manual production verification:

~~~text
CLOUDFLARE_FRONTEND_AUTO_DEPLOY=true
~~~

Keep <code>.github/workflows/pages.yml</code> and <code>public/.nojekyll</code> until the apex serves the exact promoted version and all of these pass: wallet connection, loading the existing inbox, XMTP conversation initialization, compose, reply, refresh, direct navigation, <code>_next</code>/Wasm/font assets, desktop/mobile behavior, and a saved/testable Pages rollback configuration. The current frontend has no manifest or service worker, so there is no existing PWA installation flow to validate.

## Smoke-test tooling

~~~bash
node scripts/cloudflare-smoke.mjs --suite safe
node scripts/cloudflare-smoke.mjs --suite local
node scripts/cloudflare-smoke.mjs --suite production
node scripts/cloudflare-smoke.mjs \
  --suite recovery \
  --confirm xmtp-mx-relay-production
node scripts/cloudflare-smoke.mjs \
  --suite all \
  --confirm xmtp-mx-relay-production
~~~

Use <code>--json</code> to retain machine-readable evidence. <code>safe</code> checks public health plus the HTTP/DNS portions of I/J and needs no bearer secret; if an admin token is present, it also checks private status. <code>local</code> exercises A–E against a local/dev Email Worker. <code>production</code> exercises the deployed A–E paths plus the HTTP/DNS portions of I/J. <code>recovery</code> covers destructive F/G. <code>all</code> combines those paths and requires the exact confirmation shown above plus server-side <code>RECOVERY_DRILL_ENABLED=true</code>. The CLI does not independently read the destination mailbox, prove XMTP receipt in a second client, perform wallet/browser interaction, or inspect full delivered authentication headers; retain those separate receipts to complete A, B, I, and J.

Relevant variables:

~~~text
SMOKE_EDGE_URL
SMOKE_FRONTEND_URL
SMOKE_ADMIN_TOKEN
SMOKE_INTERNAL_SECRET
SMOKE_CONTAINER_NAME
SMOKE_DOMAIN
SMOKE_INBOUND_TO
SMOKE_INBOUND_FROM
SMOKE_INBOUND_MODE=local|smtp
SMOKE_SMTP_URL
SMOKE_SMTP_INSECURE_TLS
SMOKE_XMTP_ENV
SMOKE_XMTP_BOT_ADDRESS
SMOKE_XMTP_SENDER_KEY
SMOKE_XMTP_SENDER_DB
SMOKE_XMTP_ALLOW_NEW_SENDER_INSTALLATION
SMOKE_UNAUTHORIZED_XMTP_KEY
SMOKE_UNAUTHORIZED_XMTP_DB
SMOKE_XMTP_ALLOW_NEW_UNAUTHORIZED_INSTALLATION
SMOKE_EMAIL_RECIPIENTS
SMOKE_EMAIL_CC
SMOKE_EMAIL_BCC
SMOKE_EMAIL_REPLY_TO
ETH_RPC_URL
SMOKE_WAIT_TIMEOUT_MS
SMOKE_POLL_INTERVAL_MS
CLOUDFLARE_ACCOUNT_ID
SMOKE_D1_DATABASE_ID or CLOUDFLARE_D1_DATABASE_ID
CLOUDFLARE_API_TOKEN
SMOKE_SENDING_DKIM_NAME
SMOKE_ROUTING_DKIM_NAME
SMOKE_CONTAINER_RESTART_PATH
SMOKE_CONTAINER_RECREATE_PATH
~~~

<code>SMOKE_ADMIN_TOKEN</code> is the admin bearer used for status and recovery; <code>SMOKE_INTERNAL_SECRET</code> is the Container-shared bearer used only for the authenticated event replay in E. Never print either value. Use <code>SMOKE_SMTP_INSECURE_TLS=true</code> only for a deliberately local test server, never Internet SMTP.

For staging and production, <code>SMOKE_EDGE_URL</code> is required and must be the exact Workers.dev URL printed by that Edge deployment.

The test sender databases are persistent too. Their one-time registration flags are:

~~~text
SMOKE_XMTP_ALLOW_NEW_SENDER_INSTALLATION=true
SMOKE_XMTP_ALLOW_NEW_UNAUTHORIZED_INSTALLATION=true
~~~

Use each only for its first controlled creation, then set false and retain its database. These flags never authorize creation of a new relay installation.

Acceptance H is deterministic and does not use a production failure-injection route:

~~~bash
cf-worker/node_modules/.bin/vitest run \
  --config tests/vitest.config.mjs \
  tests/cloudflare-queues.test.ts
~~~

This suite covers transient retries, final failure/DLQ recording, accepted-but-unrecorded ambiguity quarantine, and replay without a second provider send. Run all cross-layer root tests by omitting the final file argument, run the Edge Worker's own tests (including DLQ consumers) with <code>npm --prefix cf-worker test</code>, and run the Node smoke harness tests with <code>node --test tests/cloudflare-smoke.test.mjs</code>.

## Acceptance matrix

| ID | Test | Pass criteria | Evidence |
|---|---|---|---|
| A | Internet email to <code>deanpierce.eth@xmtp.mx</code> | Email Routing invokes Worker; one D1 inbound row/job; one <code>email.inbound.v1</code> arrives over XMTP | SMTP receipt, D1 rows, Queue receipt, XMTP message ID |
| B | Allowlisted <code>email.send.v1</code> | Native Email Service preserves requested fields and forced From; real mailbox receives it; sender gets one successful <code>email.send.result.v1</code> | D1 outbound row, Cloudflare message ID, received headers, XMTP result |
| C | Unauthorized sender | D1 records denial; Email Queue and Email Service show no send; sender receives <code>not_allowlisted</code> result | D1 denial and zero provider sends |
| D | Duplicate inbound delivery | Replaying the same envelope/content produces one dedupe row and one XMTP message | Unique key/count comparison |
| E | Replayed XMTP message | Reprocessing the same XMTP message ID produces one outbound request/provider acceptance | Unique key/count comparison; note crash ambiguity limitation |
| F | Container restart | Same inbox and installation return; no new installation; listener resumes | Pre/post status and network installation count |
| G | Destroy/recreate filesystem | Restore occurs from R2 before Client; same inbox and installation; no new registration | Restore log, manifest hashes, pre/post installation count |
| H | Queue retry/transient failures | Retryable state requeues; bounded retries reach success or DLQ; D1 state is coherent | Staging failure test, Queue/DLQ metrics, D1 failure rows |
| I | Production frontend | <code>https://xmtp.mx</code> serves Cloudflare artifact; routes/assets load; wallet/XMTP flow works on desktop/mobile | Headers, screenshots/manual receipt, browser console |
| J | SPF/DKIM/DMARC | DNS is correct and a real delivered message passes aligned SPF, DKIM, and DMARC | DNS output and full received headers |

Test H must use deterministic staging/local failure injection. Do not deliberately break production XMTP or Email Service merely to prove retry behavior.

After A–J, repeat A, B, F, G, I, and J from a second network or resolver before legacy removal.

## Observability

### Health and readiness

Public health answers only whether the Edge Worker can serve a minimal check. It must not claim the relay is ready unless Container identity, stream, and backup freshness are healthy.

Internal status should include:

- relay phase and readiness;
- fixed instance name;
- boot/deployment IDs;
- configured, pinned, current inbox IDs;
- expected/current installation IDs;
- stream connected and restart count;
- snapshot ID, immutable-manifest key/digest, D1 anchor identity, creation/restoration time, and backup age;
- last XMTP message received;
- last inbound email delivered;
- last outbound email accepted;
- last outbound result delivered;
- D1 pending/retrying/uncertain/failed counts;
- oldest pending inbound, outbound, and XMTP-delivery row with update time/age;
- recent persisted Queue failures;
- watchdog configured plus paused/running state;
- last error.

Actual Queue backlog, oldest-message age, consumer errors, and DLQ depth come from Cloudflare Queue metrics/dashboard/API; they are not currently returned by <code>/internal/v1/status</code>. Capture both sources in the migration receipt.

### Structured logs and alert conditions

Enable Wrangler observability and tail during migration:

~~~bash
cd cf-worker
npx wrangler tail xmtp-mx-relay-edge --format json
~~~

Create explicit high-severity alerts for:

- <code>recovery_required</code>;
- missing or corrupt anchored immutable manifest;
- missing, unavailable, stale, or mismatched D1 snapshot anchor/logical <code>latest.json</code>;
- inbox or installation mismatch;
- any attempted new production installation;
- backup older than the configured maximum;
- repeated stream restart;
- Container not ready;
- Queue DLQ growth or oldest-message age;
- outbound rows in <code>uncertain</code>;
- Email Service bounce, reject, complaint, or suppression;
- DMARC failure after enforcement begins.

Useful D1 checks:

~~~bash
npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --command "SELECT status, COUNT(*) AS count FROM inbound_email GROUP BY status"

npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --command "SELECT status, COUNT(*) AS count FROM outbound_request GROUP BY status"

npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --command "SELECT queue_name, COUNT(*) AS failures, MAX(failed_at) AS last_failure FROM queue_failure GROUP BY queue_name"

npx wrangler d1 execute RELAY_DB --remote --config wrangler.toml \
  --command "SELECT object_key, snapshot_id, created_at, sha256, updated_at FROM snapshot_anchor"
~~~

Cloudflare Paid logs have finite retention. Export or archive the migration window’s logs and smoke-test JSON with the handoff receipt.

## Cutover sequence

1. Land and validate code only. State that production is unchanged.
2. Provision staging resources and run local/staging tests with non-production XMTP identities.
3. Provision production D1, R2, Queues, DLQs, secrets, Container, and the Workers.dev Edge deployment with the watchdog paused.
4. Create the initial Railway snapshot, upload it through the gated recovery route, and verify R2 recovery during a no-dual-listener maintenance window.
5. Stop Cloudflare and resume Railway after the drill; if any recovery step failed, stop the migration.
6. Move authoritative DNS to Cloudflare while preserving the current GitHub Pages and Mailgun subdomain records exactly.
7. Onboard and test Email Sending to controlled destinations without changing MX.
8. At final handoff, stop Railway, upload the strictly newer final snapshot through the same gated route, import final D1 state, and use <code>activate-pre-mx</code> to start the single Cloudflare listener.
9. Test controlled XMTP and outbound email without changing MX.
10. Add the Email Routing rule and Cloudflare apex MX.
11. Run A–H and J.
12. Deploy the frontend to staging, perform the one-time route-free production bootstrap, preview/promote an immutable candidate, then attach the apex trigger; run I.
13. Observe for the rollback window and repeat critical tests.
14. Only then remove legacy code and services.

## Rollback

Rollback must preserve the one-listener rule.

### Before MX or frontend cutover

1. Pause delivery on both primary Cloudflare Queues and wait for in-flight consumers to finish.
2. Pause the Cloudflare watchdog and stop the Container with the authenticated stop route.
3. Verify it remains stopped through at least two Cron intervals and that no Email Service send occurs.
4. Confirm Railway volume still has the original database and pin.
5. Start Railway.
6. Verify its inbox ID, installation ID, stream, and health.
7. Resume the prior Mailgun route if it was paused. Keep Cloudflare Queue delivery paused until the incident is reconciled.

### XMTP rollback after Cloudflare processed messages

1. Pause inbound routing and outbound Queue consumers.

~~~bash
cd cf-worker
npx wrangler queues pause-delivery xmtp-mx-email-delivery-production
npx wrangler queues pause-delivery xmtp-mx-xmtp-delivery-production
~~~

2. Force and verify a final Cloudflare quiesced snapshot.
3. Export D1 state and identify <code>sending</code>/<code>uncertain</code> rows.
4. Pause the watchdog and stop the Cloudflare Container.
5. Verify it is stopped.
6. Restore the latest verified R2 XMTP DB and pin to an empty Railway volume using the same bot key.
7. Reconcile D1 dedupe/status records into the rollback relay state before enabling SMTP sends. Never blindly retry <code>uncertain</code>.
8. Start Railway and verify same inbox and installation.
9. Confirm installation count is unchanged.
10. Resume one delivery direction at a time and run controlled tests.

Use <code>npx wrangler queues resume-delivery QUEUE_NAME</code> only after the corresponding state has been reconciled. Never purge a production Queue or DLQ as a rollback shortcut.

This path must be rehearsed before deleting the original Railway volume. The old pre-cutover volume alone may be stale and may miss messages received while Cloudflare was active.

### Inbound mail rollback

The current root has no Mailgun MX. Therefore “change MX back to Mailgun” is not presently a valid rollback.

Before Cloudflare root MX cutover, either:

- configure and test Mailgun for the apex <code>xmtp.mx</code> using exact Mailgun-provided records and route; or
- accept that inbound mail will be paused during rollback while the XMTP listener is restored.

If apex Mailgun rollback was proven:

1. Pause the Cloudflare Email Routing rule.
2. Restore the recorded Mailgun apex MX/SPF/DKIM configuration exactly.
3. Verify propagation and send a uniquely identified inbound message.
4. Confirm only one provider receives it.

Do not use mixed MX priorities as a steady rollback state.

### Frontend rollback

For an application regression, use <code>wrangler versions deploy</code> to restore the last known-good production version tag. Verify that exact version at <code>xmtp.mx</code>; this preserves the Custom Domain and is the fastest rollback.

For a Cloudflare hosting or zone incident:

1. Set <code>CLOUDFLARE_FRONTEND_AUTO_DEPLOY=false</code>.
2. Remove or detach the Workers Custom Domain trigger for <code>xmtp.mx</code>.
3. Restore the recorded GitHub Pages apex DNS and repository custom-domain settings.
4. Re-enable/run <code>.github/workflows/pages.yml</code> if necessary.
5. Verify the exact Pages deployment SHA and wallet/XMTP flow.
6. Leave MX records untouched.

Vercel is a second static fallback, but it is not the current apex. Do not point production to it without verifying its environment variables and exact artifact SHA.

## Legacy-removal gates

Remove items only after:

- A–J pass;
- restart and destroyed-filesystem recovery pass twice;
- installation count is unchanged;
- a fresh R2 backup exists and can be restored;
- Railway rollback has been rehearsed;
- Mailgun apex rollback or an explicit inbound-pause plan exists;
- no D1 rows remain unexpectedly pending, retrying, or uncertain;
- Queue and DLQ state is understood;
- Email Service delivery/authentication is healthy;
- the frontend apex is confirmed on Cloudflare;
- the observation window is complete.

Then remove:

- Mailgun SDK and webhook code;
- Mailgun fake webhook tooling;
- <code>MAILGUN_API_KEY</code>;
- <code>MAILGUN_DOMAIN</code>;
- <code>MAILGUN_FROM</code>;
- <code>MAILGUN_WEBHOOK_SIGNING_KEY</code>;
- obsolete Mailgun DNS records;
- Railway service and volume, after a final encrypted archival backup;
- obsolete cron-poller/KV Worker;
- GitHub Pages workflow and <code>.nojekyll</code>;
- Vercel project/integration;
- stale documentation.

Record the removal date, final Cloudflare deployment/version IDs, R2 snapshot ID, D1 migration version, DNS record set, and final A–J receipts.

## Stop conditions

Stop and keep or restore Railway if any of the following is true:

- no authenticated Cloudflare account or Workers Paid entitlement;
- no full DNS inventory or registrar access;
- production DB/pin/key/expected IDs cannot be obtained;
- a consistent R2 snapshot cannot be made and read back;
- restoration creates or requires a new installation;
- the inbox or installation ID changes;
- two production listeners may be active;
- D1 legacy import cannot be reconciled;
- Email Sending cannot deliver to arbitrary intended recipients;
- Queue failures cannot be inspected or recovered;
- an apex inbound rollback path has not been decided;
- real production A–J evidence cannot be collected.

Never weaken the installation-safety checks to get past a deployment blocker.

## Cloudflare reference set

- [Containers overview](https://developers.cloudflare.com/containers/)
- [Container architecture and lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)
- [D1](https://developers.cloudflare.com/d1/)
- [Queues](https://developers.cloudflare.com/queues/)
- [R2](https://developers.cloudflare.com/r2/)
- [Email Routing and Email Workers](https://developers.cloudflare.com/email-routing/email-workers/)
- [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
