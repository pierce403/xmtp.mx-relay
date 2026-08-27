# xmtp.mx-relay - Features

No Cloudflare production deployment, DNS cutover, Email Service send, or production recovery drill has been completed. “Implemented” below means checked-in code with local automated coverage; production acceptance remains open. Railway/Mailgun is retained as the rollback service.

## Features

### SMTP → XMTP Inbound Relay
- **Stability**: implemented for Cloudflare; production verification pending
- **Description**: Cloudflare Email Routing invokes `email()`, which validates the envelope and raw MIME, persists/dedupes the event in D1, and publishes an XMTP delivery job. The singleton Container delivers `email.inbound.v1` over XMTP.
- **Properties**:
  - Rejects recipients not matching `INBOUND_EMAIL_TO`
  - Enforces raw-message and normalized payload size limits
  - Dedupes with SHA-256 over the normalized SMTP envelope plus exact raw MIME; `Message-ID` is metadata, not the dedupe authority
  - Persists the D1 row/job before asynchronous Queue delivery
  - Uses D1 unique keys to suppress ordinary at-least-once Queue replays
- **Test Criteria**:
  - [x] Local Worker tests cover parsing, persistence, retry, and duplicate handling
  - [ ] Real Internet email reaches `deanpierce.eth@xmtp.mx` exactly once over XMTP
  - [ ] Cloudflare Email Routing and apex MX are verified in production

### XMTP → SMTP Outbound Relay
- **Stability**: implemented for Cloudflare; production verification pending
- **Description**: The Container streams real `email.send.v1` messages, the Worker authorizes and persists them in D1, and a Queue consumer sends through the native Cloudflare Email Service binding before returning `email.send.result.v1` over XMTP.
- **Properties**:
  - D1 allowlist contains resolved, normalized XMTP inbox IDs; the Edge Worker does not resolve ENS names or wallet addresses
  - Outbound requests are deduped by XMTP message ID
  - Recipient count/shape and payload sizes are validated
  - `From` is forced to `EMAIL_FROM`; `to`, `cc`, `bcc`, `subject`, `text`, `html`, and `replyTo` semantics are retained
  - Accepted-but-unrecorded provider outcomes are quarantined as `uncertain`, not blindly retried
- **Test Criteria**:
  - [x] Local tests cover allowlist denial, replay suppression, Queue retry, DLQ recording, and ambiguous-send quarantine
  - [ ] An allowlisted production sender triggers one real Cloudflare send and receives one success result
  - [ ] An unauthorized production sender cannot cause an email send

### Cloudflare-native application persistence
- **Stability**: implemented; production import pending
- **Description**: D1 replaces `relay.sqlite` for Cloudflare application state while Queues provide persisted asynchronous delivery.
- **Properties**:
  - D1 stores inbound mail, outbound requests, allowlist members, thread maps, delivery/retry state, Queue failures, watchdog state, and the snapshot freshness anchor
  - Short-gap recovery republishes only unconfirmed `received` handoffs; a separate 24-hour recovery path repairs safe `queued`/`retrying` pointers lost after finite DLQ retries without replaying ambiguous in-flight sends
  - Checked-in exporter reads a stopped legacy `relay.sqlite` and emits idempotent D1 SQL
  - Legacy `sending` rows become `uncertain`; ambiguous work is never automatically re-driven
- **Test Criteria**:
  - [x] Local schema/idempotency tests pass
  - [ ] Stopped Railway source rows and D1 destination rows/keys are reconciled before handoff

### XMTP installation persistence and recovery
- **Stability**: implemented; production restore drill pending
- **Description**: The active encrypted XMTP SQLite database stays on local Container storage. A child-process quiesce produces HMAC-signed, immutable multipart snapshots in R2; D1 anchors the newest signed pointer against rollback.
- **Properties**:
  - Restore occurs before `Client` construction on an empty filesystem
  - Pin, inbox ID, installation ID, environment, hashes, sizes, part order, and free space are verified
  - Normal production requires `XMTP_ALLOW_NEW_INSTALLATION=false`
  - Runtime recovery accepts signed v2 snapshots only; a stopped legacy database must be converted by the offline exporter
  - The SDK client/stream runs in a child process so process exit is the exclusive-writer backup boundary
- **Test Criteria**:
  - [x] Synthetic local multipart backup/restore and corruption tests pass
  - [ ] Restart and intentionally destroyed-filesystem drills recover the same production installation without increasing network installation count

### Singleton listener and lifecycle
- **Stability**: implemented; Cloudflare runtime verification pending
- **Description**: One stable `xmtp-mx-relay-production` Container runs the real `streamAllMessages(...)` listener. A Durable Object wrapper suppresses inactivity shutdown and a one-minute Cron watchdog supervises lifecycle and durable outbox repair; Cron never polls XMTP.
- **Properties**:
  - `max_instances=1`, fixed instance name, Container `/livez`, `/healthz`, and `/readyz`
  - Recovery-required holds keep `/livez` up for inspection while `/healthz` and `/readyz` fail; transient fatal lifecycle failures exit nonzero for restart
  - Public Edge `/healthz`; detailed status and lifecycle routes require an admin bearer
  - Watchdog pause is persisted before a planned stop, enabling a no-dual-listener Railway handoff/rollback
  - Missing/invalid watchdog state fails closed; only authenticated activation writes explicit running intent
  - GitHub workflow can validate automatically and perform only a guarded, manual, pre-MX deploy from `main`
- **Test Criteria**:
  - [x] Local Worker/Container lifecycle and synthetic recovery tests pass
  - [ ] Deployed Container stays running, recovers after exit, and never overlaps the Railway listener

### Legacy Railway/Mailgun rollback
- **Stability**: retained until Cloudflare acceptance and observation gates pass
- **Description**: The root Node service, persistent Railway volume, Mailgun webhook/sender, and `relay.sqlite` remain available for rollback. They are not the target architecture.
- **Test Criteria**:
  - [ ] Railway identity/installation and health are recorded immediately before handoff
  - [ ] Rollback is rehearsed without running two production listeners
  - [ ] Mailgun is removed only after Cloudflare inbound/outbound and rollback gates pass

### Attachments
- **Stability**: planned
- **Description**: Support inbound and outbound attachments via stored MIME + object storage links.
- **Properties**:
  - Attachments are stored outside XMTP payloads in a separate object prefix/bucket with expiring links
  - XMTP message includes metadata + links
- **Test Criteria**:
  - [ ] Inbound email with attachments results in XMTP message containing attachment links
  - [ ] Outbound send with attachments delivers correct attachments through the canonical provider

### Reply Threading
- **Stability**: planned
- **Description**: Maintain thread continuity using `Message-Id`, `In-Reply-To`, and `References`.
- **Properties**:
  - `thread_map` maps email message ids to thread ids
  - Replies preserve threading headers
- **Test Criteria**:
  - [ ] Reply to an inbound email produces an email with correct threading headers

### Multi-user XMTP.mx
- **Stability**: planned
- **Description**: Support multiple `*.eth@xmtp.mx` recipients via a binding/verification handshake.
- **Properties**:
  - Users must verify ownership before enabling relay
  - Per-user allowlists and quotas
- **Test Criteria**:
  - [ ] New user can complete verification and receive inbound email over XMTP
  - [ ] Outbound sending is gated by token/allowlist verification

### Token Gating (Outbound)
- **Stability**: planned
- **Description**: Add a credential or token rule in addition to the mandatory XMTP inbox-ID allowlist.
- **Properties**:
  - The relay is never open by default; token gating would narrow the existing allowlist
  - Denied requests return an explicit error
- **Test Criteria**:
  - [ ] Requests without the required token are rejected
  - [ ] Valid token holders can send successfully
