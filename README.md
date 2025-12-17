# xmtp.mx-relay

Bidirectional relay between SMTP (Mailgun) and XMTP.

## Overview

- **Inbound (SMTP → XMTP):** Email to `INBOUND_EMAIL_TO` is forwarded by Mailgun to `POST /webhooks/mailgun/inbound`, verified, normalized, stored in SQLite, then delivered to `XMTP_DEAN_ADDRESS` as a structured `email.inbound.v1` JSON message.
- **Outbound (XMTP → SMTP):** Allowlisted XMTP senders send `email.send.v1` JSON to the bot; the relay sends a real email via Mailgun and replies with `email.send.result.v1`.

Persistence:
- Relay state is stored in `DATA_DIR/relay.sqlite` (mount `DATA_DIR=/data` on Railway).
- XMTP Node SDK stores its local DB under `DATA_DIR/` (`xmtp-<env>-<inbox-id>.db3`).

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

## Local dev

1. Install deps: `npm install`
2. Configure env: `cp .env.example .env` and fill values
3. Run: `npm run dev`

Inbound webhook smoke test (posts a correctly-signed payload):
- `npm run fake:mailgun`

Endpoints:
- `GET /healthz`
- `POST /webhooks/mailgun/inbound`

## Security defaults

- Mailgun webhook signature verification is required (`MAILGUN_WEBHOOK_SIGNING_KEY`).
- Outbound sends are restricted to `XMTP_ALLOWED_SENDERS` (resolved to XMTP inbox IDs).
- You can set `XMTP_ALLOWLIST_BYPASS=true` during local testing to permit any XMTP sender (do not enable in prod).
- Webhook is rate-limited and size-limited via env vars.
- Outbound email `From:` is forced to `MAILGUN_FROM` (never taken from user input).

## Railway deploy (recommended)

1. Use the included `Dockerfile`.
2. Mount a persistent volume at `/data` and set `DATA_DIR=/data`.
3. Set required env vars in Railway.
4. Configure Mailgun to forward inbound email for `INBOUND_EMAIL_TO` to:
   - `POST https://<your-public-domain>/webhooks/mailgun/inbound`
