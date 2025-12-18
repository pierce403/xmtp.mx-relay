# xmtp.mx-relay - Features

## Features

### SMTP → XMTP Inbound Relay
- **Stability**: in-progress
- **Description**: Accept Mailgun inbound webhooks, verify signature, normalize, store/dedupe in SQLite, and deliver to Dean as `email.inbound.v1` JSON over XMTP.
- **Properties**:
  - Rejects invalid Mailgun signatures (HTTP 403)
  - Ignores recipients not matching `INBOUND_EMAIL_TO`
  - Dedupes inbound events by Mailgun `message-id` (or `Message-Id` fallback)
  - Persists inbound emails in `inbound_email` with `xmtp_sent_at` set only after XMTP send succeeds
- **Test Criteria**:
  - [ ] Invalid signature returns 403 and no DB insert
  - [ ] Valid inbound email is delivered over XMTP as `email.inbound.v1`
  - [ ] Duplicate inbound delivery does not generate a second XMTP message

### XMTP → SMTP Outbound Relay
- **Stability**: in-progress
- **Description**: Any XMTP sender can send `email.send.v1` JSON to the bot; the relay sends a real email via Mailgun and replies with `email.send.result.v1`.
- **Properties**:
  - Outbound requests are deduped by XMTP message id
  - Outbound emails always use `MAILGUN_FROM` (never user-provided `From`)
- **Test Criteria**:
  - [ ] Sender triggers a single Mailgun send and gets a success result
  - [ ] Replaying the same XMTP message id does not send a second email

### Persistence & Idempotency (SQLite)
- **Stability**: in-progress
- **Description**: SQLite stores relay state and provides idempotency for both inbound and outbound flows.
- **Properties**:
  - Relay state is stored at `DATA_DIR/relay.sqlite`
  - XMTP Node SDK stores its local DB under `DATA_DIR/` (`xmtp-<env>-<inbox-id>.db3`)
  - Inbound dedupe and outbound dedupe prevent duplicates across restarts
- **Test Criteria**:
  - [x] `npm run typecheck` passes
  - [x] `npm run build` succeeds
  - [ ] Restarting the service does not resend previously sent inbound/outbound events

### Webhook Security & Abuse Controls
- **Stability**: in-progress
- **Description**: Prevent open-relay abuse and webhook spoofing.
- **Properties**:
  - Mailgun signature verification required (`MAILGUN_WEBHOOK_SIGNING_KEY`)
  - Webhook rate limiting enabled
  - Payload size limit enforced
- **Test Criteria**:
  - [ ] Invalid signature returns 403
  - [ ] Excessive requests return 429

### Deployment (Railway)
- **Stability**: in-progress
- **Description**: Single always-on process deployable to Railway with a persistent volume.
- **Properties**:
  - Docker-based deployment supported (`Dockerfile`)
  - Persistent volume at `/data` recommended (`DATA_DIR=/data`)
  - Health endpoint available at `GET /healthz`
- **Test Criteria**:
  - [ ] Container boots and serves `/healthz`
  - [ ] Mounted volume retains `relay.sqlite` across deploys

### Attachments
- **Stability**: planned
- **Description**: Support inbound and outbound attachments via stored MIME + object storage links.
- **Properties**:
  - Attachments are stored outside XMTP payloads (R2/S3) with expiring links
  - XMTP message includes metadata + links
- **Test Criteria**:
  - [ ] Inbound email with attachments results in XMTP message containing attachment links
  - [ ] Outbound send with attachments delivers correct attachments via Mailgun

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
- **Description**: Require a token/credential check before allowing outbound sends.
- **Properties**:
  - Open by default; can be toggled to enforce token gating
  - Denied requests return an explicit error
- **Test Criteria**:
  - [ ] Requests without the required token are rejected
  - [ ] Valid token holders can send successfully
