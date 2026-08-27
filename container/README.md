# Cloudflare XMTP relay Container

This image runs the one always-on `@xmtp/node-sdk` listener for xmtp.mx. The
Cloudflare Worker must route every request to the single Durable Object name
`xmtp-mx-relay-production`, and Wrangler must set `max_instances = 1`.

The process is split deliberately:

- the supervisor owns HTTP, authentication, R2 backup/restore, and child
  lifecycle;
- a forked child exclusively owns the XMTP Client, encrypted SQLite database,
  and `xmtp.conversations.streamAllMessages(...)`;
- a backup disables delivery, waits for in-flight delivery, ends and exits the
  child, rejects any nonempty `-wal`, `-shm`, or `-journal`, reads the now-closed
  database into immutable content-addressed chunks, verifies every
  upload by downloading and hashing it, publishes an authenticated `latest.json`
  last, and restarts the child.

Do not change this to live file copying, SQLite-on-R2/FUSE, or generic SQLite
backup tooling. The XMTP SDK does not expose `Client.close()`, and its database
encryption means an unrelated SQLite client is not a safe consistency oracle.

## HTTP contract

The image listens on port 8080.

- `GET /livez` — process liveness. This remains 200 for a fail-closed
  recovery-required condition so operators can inspect it without a platform
  restart loop.
- `GET /healthz` — 503 for a terminal fatal/recovery-required state; otherwise
  200. Cloudflare's Container ping uses `/livez`, not this health signal.
- `GET /readyz` — 200 only after restore, independent identity checks, XMTP sync,
  stream startup, and a verified fresh snapshot.
- `GET /internal/v1/status` — detailed authenticated status.
- `POST /internal/v1/xmtp/deliver` — authenticated Worker-to-XMTP delivery.
- `POST /internal/v1/admin/backup` — authenticated quiesced backup and restart.

Internal routes require `Authorization: Bearer $CONTAINER_SHARED_SECRET` and
must not be directly exposed by the public Worker router.

Delivery body:

```json
{
  "jobId": "durable-edge-job-id",
  "kind": "email.inbound.v1",
  "payload": {
    "type": "email.inbound.v1",
    "to": "deanpierce.eth@xmtp.mx",
    "from": "sender@example.com",
    "subject": "Hello",
    "text": "Hello",
    "html": null,
    "messageId": "<message-id@example.com>",
    "receivedAt": "2026-08-27T00:00:00.000Z"
  }
}
```

`email.send.result.v1` also supplies the original `conversationId` or
`recipientInboxId` (`senderInboxId` is accepted as a compatibility alias).
Success returns `xmtpMessageId`. The supervisor dedupes a `jobId` within one
Container boot; the Durable Object/D1 job receipt remains the durable
exactly-once authority across replacement.

The child sends parsed XMTP events to
`$EDGE_INTERNAL_URL/internal/v1/xmtp/events`:

```json
{
  "messageId": "XMTP message ID",
  "senderInboxId": "64 hex characters",
  "conversationId": "XMTP conversation ID",
  "content": "{\"type\":\"email.send.v1\",...}",
  "receivedAt": "2026-08-27T00:00:00.000Z"
}
```

Legacy fenced/extracted JSON is canonicalized before this handoff. The edge
must persist/dedupe the message in D1 before acknowledging it.

## Worker outbound-handler contract

Containers access bindings through private virtual hostnames rather than R2
credentials:

- `http://xmtp-edge.internal` handles the event endpoint above.
- `http://xmtp-r2.internal/v1/objects/:encodedKey` supports authenticated GET
  and PUT against the backup bucket. PUT includes exact `Content-Length` and
  `x-object-sha256`; the handler must bound the streamed body and reject objects
  over the configured maximum.

## Required production configuration

Set secrets through Wrangler/Cloudflare Secrets and pass them through the
Container class. Never commit their values.

- `XMTP_BOT_KEY` (secret)
- `CONTAINER_SHARED_SECRET` (secret, at least 32 characters)
- `XMTP_SNAPSHOT_SIGNING_KEY` (independent escrowed recovery secret, at least 32
  characters; do not derive it from the transport token)
- `XMTP_DEAN_ADDRESS`
- `XMTP_EXPECTED_INBOX_ID` (independently recorded, 64 hex characters)
- `XMTP_EXPECTED_INSTALLATION_ID` (independently recorded)
- `XMTP_ALLOW_NEW_INSTALLATION=false`
- `EDGE_INTERNAL_URL=http://xmtp-edge.internal`
- `R2_INTERNAL_BASE_URL=http://xmtp-r2.internal`
- `XMTP_R2_PREFIX=xmtp-mx-relay-production/xmtp`

See `.env.example` for bounded tuning values and defaults. Emergency installation
revocation is intentionally forbidden.

Treat `XMTP_SNAPSHOT_SIGNING_KEY` as recovery-root material and escrow it
separately. Transport-token rotation must not change it. This implementation has
no dual-key verification window: rotating the snapshot key requires a controlled
paused migration that republishes and verifies a snapshot signed by the new key
before the old key is retired.

### R2 snapshot v2

The Container never sends a whole database through a Worker request. It writes
only v2 snapshots, with a 16 MiB default chunk and an absolute 32 MiB per-object
limit. `XMTP_MAX_BACKUP_BYTES` remains the total database limit;
`XMTP_BACKUP_PART_BYTES` is the per-request chunk size. The immutable layout is:

```text
<prefix>/snapshots/<uuid>/database/part-000000-<part-sha256>.bin
<prefix>/snapshots/<uuid>/database/part-000001-<part-sha256>.bin
<prefix>/snapshots/<uuid>/xmtp-inbox-id.txt
<prefix>/snapshots/<uuid>/manifest.json
<prefix>/latest.json
```

The offline export's `latest.json` and immutable `manifest.json` contain the same
full manifest. At runtime, `latest.json` is a D1-anchored virtual pointer served
from that immutable manifest rather than a mutable R2 object. Database
metadata is `{sha256,bytes,partSizeBytes,parts:[{index,offset,key,sha256,bytes}]}`.
The signature is `{algorithm:"hmac-sha256",value}` and covers every other field
using recursively key-sorted canonical JSON, domain-separated with
`xmtp.mx/xmtp-snapshot-manifest/v2\0`. Each immutable part, pin, and manifest is
created with `If-None-Match: *`, then read back and checked for exact size and
SHA-256. `latest.json` is published only after all of those checks succeed.

The Worker must cap each R2 request at 32 MiB independently of the total backup
limit. It also anchors `{snapshotId,createdAt,sha256}` for `latest.json` in D1:
strictly newer snapshots may replace the anchor, an identical retry is allowed,
and older or equal-time/different snapshots are rejected. GET must return only
the immutable manifest whose identity and digest match that anchor. The HMAC proves authenticity;
the Worker/D1 anchor supplies freshness and rollback resistance. A rejected PUT
or mismatched readback fails the backup and prevents startup readiness.
Permanent 4xx publication/integrity failures enter `recovery_required`, stop the
XMTP child, and require operator intervention; they are not silently retried on
potentially stale state.

Non-recovery startup or backup failures request a graceful process shutdown
with exit status 1 so Cloudflare can restart the Container. An unexpected child
exit is restarted once in-process; a failed restart escalates to the same
process replacement path. A reported live-stream failure terminates the child
immediately, with a five-second kill backstop, so an HTTP-only process cannot
remain alive after its real-time listener has died.

Before a snapshot, `statfs` must prove the configured
`XMTP_FREE_SPACE_MARGIN_BYTES` remains available on the local data filesystem.
Before restore it must prove space for the complete database plus that margin.
Restore validates the signed manifest and exact part layout first, downloads one
bounded part at a time into a same-filesystem staging file, verifies every part
and the concatenated database hash, fsyncs, then renames. Missing, reordered,
oversized, or corrupt parts fail closed without constructing the XMTP Client.

Runtime recovery accepts signed v2 manifests only. There is no unsigned-v1
compatibility switch: migrate a stopped legacy database with `snapshot:export`
rather than weakening authentication during recovery.

At startup the supervisor compares the independent expected IDs to the R2
manifest and restored `xmtp-inbox-id.txt` before forking the XMTP process. The
child then compares wallet/network inbox, pin, `Client.inboxId`, and
`Client.installationId` before sync, stream startup, or delivery. Missing or
partial state with `XMTP_ALLOW_NEW_INSTALLATION=false` emits the structured
`XMTP_RECOVERY_REQUIRED` alert and never constructs the Client.
Normal production also refuses an otherwise intact local DB/pin when the Worker
cannot return its authenticated D1-anchored snapshot lineage. Only the explicit
first-ever bootstrap may temporarily have local state before its first anchor.

`Client.create` always runs with `disableAutoRegister:true`. A restored database
must already report a registered installation; otherwise startup fails without
calling `register()`. Only the explicitly confirmed first-ever bootstrap branch
calls `client.register()`.

## Migrating the existing installation

Do not use the new-install bootstrap for the current xmtp.mx identity.

1. Stop the Railway process cleanly so it is no longer writing its data volume.
2. If the existing deployment did not log `Client.installationId`, inspect the
   stopped database with automatic registration disabled. This dedicated
   process exits before export and refuses nonempty sidecars:

   ```sh
   cd container
   npm ci
   XMTP_BOT_KEY='set-through-your-secret-shell' npm run identity:inspect -- \
     --data-dir /path/to/railway-data \
     --xmtp-env production \
     --confirm-relay-stopped yes
   ```

   Record the returned inbox and installation IDs independently. The tool never
   calls `register()`; if the DB is absent or unregistered, it fails.
3. Export the stopped volume. The command refuses nonempty WAL/SHM/journal
   sidecars:

   ```sh
   cd container
   npm ci
   XMTP_SNAPSHOT_SIGNING_KEY='set-through-your-secret-shell' \
   npm run snapshot:export -- \
     --data-dir /path/to/railway-data \
     --output-dir /safe/export-directory \
     --xmtp-env production \
     --inbox-id "$XMTP_EXPECTED_INBOX_ID" \
     --installation-id "$XMTP_EXPECTED_INSTALLATION_ID" \
     --part-bytes 16777216 \
     --max-backup-bytes 1073741824 \
     --replay-after 1970-01-01T00:00:00.000Z
   ```

4. Pause the edge watchdog and stop the stable production Container. Temporarily
   deploy the Worker with `RECOVERY_IMPORT_ENABLED=true`; its recovery import
   route must independently require `RECOVERY_ADMIN_TOKEN`, the exact production
   confirmation, a paused watchdog, and a stopped Container.
5. Upload and verify the export through that bounded admin route. Tokens remain
   in environment variables, never command arguments:

   ```sh
   cd container
   CLOUDFLARE_RECOVERY_ADMIN_TOKEN='set-through-your-secret-shell' \
   XMTP_SNAPSHOT_SIGNING_KEY='same-escrowed-key-used-for-export' \
   npm run snapshot:upload -- \
     --input-dir /safe/export-directory \
     --edge-url https://relay-worker.example \
     --confirm xmtp-mx-relay-production \
     --max-backup-bytes 1073741824
   ```

   The uploader verifies the local signature, layout, complete DB hash metadata,
   and every file before network I/O. It uploads parts, pin, and immutable
   manifest with exact length/SHA and `If-None-Match: *`, reads each back, and
   publishes `latest.json` last. The latest request verifies the immutable
   manifest and advances the D1 anchor; it does not write a mutable R2 pointer.
6. Immediately redeploy with `RECOVERY_IMPORT_ENABLED=false`, configure both
   expected IDs, leave `XMTP_ALLOW_NEW_INSTALLATION=false`, and start the
   Container.
7. Require signed restore, `/readyz`, and `/internal/v1/status` to show the same
   D1 anchor, inbox, and installation IDs before any SMTP cutover.

The epoch replay cutoff is intentionally conservative for migration. D1
deduplication must be populated before startup so replay cannot resend already
processed outbound mail.

## First-ever identity bootstrap only

This is not the Railway migration path. For a genuinely new production identity,
derive and configure `XMTP_EXPECTED_INBOX_ID`, omit the not-yet-known expected
installation ID, and temporarily set both:

```text
XMTP_ALLOW_NEW_INSTALLATION=true
XMTP_BOOTSTRAP_CONFIRM=I_UNDERSTAND_THIS_REGISTERS_A_NEW_XMTP_INSTALLATION
```

The supervisor creates the installation once, immediately performs a verified
quiesced snapshot, and exposes the resulting installation ID in authenticated
status. Record that value, configure `XMTP_EXPECTED_INSTALLATION_ID`, remove the
confirmation variable, set `XMTP_ALLOW_NEW_INSTALLATION=false`, and restart.

Before constructing the bootstrap Client, the supervisor writes and verifies a
persistent `bootstrap-attempt.json` marker in R2. If the Container dies after
registration but before its first snapshot, a replacement sees that marker and
fails closed instead of registering again. Do not delete the marker to retry
blindly; determine whether registration occurred and recover that installation.

## Recovery drill

The local drill creates a closed test database, publishes a snapshot to a local
R2-shaped directory, deletes the tool-created ephemeral data directory, restores
with new-install disabled, and verifies the bytes, inbox, installation, and
replay cutoff without constructing an XMTP Client:

```sh
cd container
npm ci
npm run recovery:drill
```

The production acceptance drill must additionally use the Worker's protected
restart/recreate controls, then compare authenticated status before and after.
Do not cut over MX until `currentInboxId`, `pinnedInboxId`, and `installationId`
are unchanged.

## Replay watermark and known blocker

Every source message advances the processed watermark only after it has been
safely completed: a canonical `email.send.v1` must be durably accepted by D1,
while self-sent, unsupported, empty, greeting, and other intentionally ignored
messages advance only after their handling is complete. This prevents an
inbound-only inbox from leaving the cutoff at the Unix epoch and eventually
hitting the per-conversation catch-up limit forever. Snapshots retain a replay
cutoff five minutes behind the watermark. Snapshot creation time never advances
the cutoff, so an edge POST aborted for backup is replayed after restart and
deduped by D1. There is no edge-delivery retry limit: the awaited stream handler
uses capped backoff and backpressures later messages until the failed canonical
source event is durable or shutdown begins. The in-process stream/catch-up
overlap cache is bounded; D1 remains the durable dedupe authority.
If catch-up reaches `XMTP_CATCHUP_MESSAGES_PER_CONVERSATION` before that cutoff,
startup fails instead of silently creating a history gap; raise the bound only
after assessing memory and message volume.

Each backup briefly pauses the XMTP child. The live stream is restored immediately
and the overlap catch-up closes the gap; this is not cron polling. If a clean SDK
child exit does not remove/checkpoint nonempty WAL or SHM files in production,
the backup fails closed. That condition is a platform/SDK blocker: do not delete
the sidecars, copy a live database, enable new installation creation, or complete
the Railway cutover until it is resolved and a destructive-filesystem recovery
drill passes.
