# TODO

No Cloudflare production cutover or production recovery drill has occurred. Complete these gates in [docs/cloudflare-migration-runbook.md](docs/cloudflare-migration-runbook.md); do not infer completion from builds or local tests.

## Provision and inspect

- [ ] Obtain authenticated Cloudflare, Railway, registrar/DNS, Mailgun rollback, production secret, and controlled mailbox/test-identity access
- [ ] Confirm Workers Paid, Containers, Email Service arbitrary-recipient access/quota, Email Routing, D1, R2, Queues, and DLQs
- [ ] Replace the D1 placeholder ID, apply migrations, and verify tables/bindings/Queue consumers
- [ ] Configure all Cloudflare Secrets, including the independent snapshot signing key; never commit values
- [ ] Resolve the production allowlist to normalized 64-hex XMTP inbox IDs and compare the complete imported D1 list

## Preserve the production XMTP installation

- [ ] Deploy the additive Railway `xmtp.ready` installation-ID diagnostic and record the current inbox, installation, and network installation count
- [ ] During a no-dual-listener maintenance window, stop Railway and run `container` identity inspection against the stopped volume
- [ ] Export a signed multipart v2 snapshot with no live WAL/journal; upload immutable parts/pin/manifest and publish the logical `latest.json`/D1 anchor last
- [ ] Verify every R2 object by read-back hash/size and establish the D1 monotonic snapshot anchor
- [ ] Import stopped `relay.sqlite` into D1; compare counts, dedupe keys, outbound message IDs, allowlist members, and thread maps
- [ ] Rehearse restart and destroyed-filesystem restoration; require the same inbox/installation and unchanged network installation count
- [ ] Keep `XMTP_ALLOW_NEW_INSTALLATION=false`; stop the migration on any `recovery_required` condition

## Staged delivery and cutover

- [ ] Run protected `deploy-paused` from `main`, upload/anchor the signed snapshot while the Container remains stopped, then run `activate-pre-mx` only after Railway is demonstrably stopped
- [ ] Test native Cloudflare Email Service outbound to controlled and arbitrary controlled destinations before changing MX
- [ ] Prove allowlisted outbound, unauthorized denial, replay suppression, result delivery, and ambiguous-state quarantine
- [ ] Configure Email Routing and the exact Cloudflare-generated MX/SPF/DKIM records
- [ ] Run real Internet inbound, duplicate inbound, Queue retry/DLQ, restart, and destroyed-filesystem recovery tests
- [ ] Verify real recipient headers for aligned SPF, DKIM, and DMARC
- [ ] Move the static frontend through staging, immutable production candidate preview, exact-version promotion, and one-time `xmtp.mx` trigger attachment
- [ ] Record production acceptance A–J and repeat critical checks from a second network/resolver

## Rollback and removal gates

- [ ] Rehearse watchdog pause → Cloudflare listener stop → Railway start without overlap
- [ ] Create/test an apex Mailgun inbound rollback route or explicitly accept that inbound mail pauses during rollback
- [ ] Preserve Railway volume, Mailgun, GitHub Pages, and Vercel until the observation window and rollback drills pass
- [ ] Reconcile every `sending`/`uncertain` row manually before retry or removal
- [ ] Only after all gates pass, remove Mailgun code/secrets/DNS, Railway, the obsolete cron poller, GitHub Pages, and Vercel

## Product backlog

- [ ] Attachments: store MIME/object data outside XMTP payloads and use expiring links
- [ ] Complete reply threading through `Message-Id`, `In-Reply-To`, and `References`
- [ ] Add multi-recipient/user verification, quotas, and backpressure
- [ ] Add optional help replies for invalid/unknown XMTP payloads
- [ ] Address reviewed dependency audit findings without forced upgrades
