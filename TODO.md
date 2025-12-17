# TODO

## V1 “It Works” Checklist

- [ ] Configure a real Mailgun Route to `POST /webhooks/mailgun/inbound` and verify SMTP→XMTP delivery end-to-end
- [ ] Send a real `email.send.v1` XMTP message from an allowlisted sender and verify XMTP→SMTP delivery end-to-end
- [ ] Replay the same inbound event and confirm dedupe prevents a second XMTP send
- [ ] Replay the same outbound XMTP message and confirm dedupe prevents a second Mailgun send
- [ ] Invalid Mailgun signature returns 403 and does not enqueue / store
- [ ] Non-allowlisted XMTP sender is denied (and gets `email.send.result.v1` error)

## Production Hardening

- [ ] Add `/readyz` that checks DB + XMTP client initialized
- [ ] Add admin alerting on outbound send failures + repeated inbound send failures (optional `ADMIN_XMTP_ADDRESS`)
- [ ] Add webhook IP allowlist option (Mailgun IPs) or shared secret path segment
- [ ] Add per-recipient + per-sender quotas and backpressure controls

## Inbound SMTP Improvements

- [ ] Store raw MIME (Mailgun `body-mime`) for future parsing
- [ ] Attachments: store + fetch MIME, upload to object storage, include links in XMTP
- [ ] Multi-recipient handling (To/CC lists) and normalization
- [ ] Threading map using `Message-Id` / `In-Reply-To` / `References`

## Outbound XMTP Improvements

- [ ] Optional “help” reply for non-JSON / unknown message types
- [ ] Enforce max sizes for `text/html` and recipient lists
- [ ] Improve `replyTo` handling (force verified sender; don’t trust user `from`)

## Testing / Quality

- [ ] Add unit tests for Mailgun signature verification + normalization + dedupe keys
- [ ] Add Mailgun API mocking tests (e.g. with `nock`) for outbound send paths
- [ ] Address `npm audit` findings (avoid `--force` unless reviewed)

