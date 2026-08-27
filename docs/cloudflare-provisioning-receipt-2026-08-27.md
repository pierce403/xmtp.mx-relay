# Cloudflare provisioning receipt — 2026-08-27

This receipt records the non-secret production resources and paused SMTP
ingest deployed before the XMTP identity handoff. It is not an XMTP listener
activation receipt.

## Source and validation

- Relay source: `e1846ac51a20ec1925e1a301f7e6447fa1c98e08` on `main`
- GitHub validation: run `33087299733`, successful
- Cloudflare Worker tests: 75 passed
- Cross-layer Worker tests: 33 passed
- Cloudflare smoke harness: 14 passed
- Container tests: 45 passed
- Worker/Container `wrangler deploy --dry-run`: passed

## Provisioned resources

- D1: `xmtp-mx-relay-production`
  (`2a73f259-c5db-4411-ba74-38ce9f72f652`, WNAM)
- R2: `xmtp-mx-xmtp-state-production`
- Queue: `xmtp-mx-email-delivery-production`
- DLQ: `xmtp-mx-email-delivery-dlq-production`
- Queue: `xmtp-mx-xmtp-delivery-production`
- DLQ: `xmtp-mx-xmtp-delivery-dlq-production`
- Email Sending domain: `xmtp.mx`, enabled
- Edge Worker: `xmtp-mx-relay-edge`
  (`https://xmtp-mx-relay-edge.bcrt43.workers.dev`)
- First deployed code version: `e5f5c44e-fb33-4a1d-817f-13e1befbacfc`
- Current version with both inbound aliases: `1423b609-bc48-41c8-b281-a0f3ee8ea091`
- Container application: `a0363b9f-d19a-45cd-ab81-1ded7a59399e`
- Container image: `sha256:4c0dece9178ce169027f1a7ef2279eef700e4367c2cb0f1b5d99472144d30acf`

D1 migration `0001_cloudflare_relay.sql` was applied. The durable
`watchdog_pause` record was verified with `paused: true`; the authenticated
stop path refreshed it with reason `operator_stop` at
`2026-08-27T14:52:56.350Z`. Cron subsequently recorded a healthy paused
watchdog. The only Container instance is `inactive` and has never had the XMTP
bot or expected-installation secrets needed to start a listener.

## DNS state

Cloudflare is authoritative through `cash.ns.cloudflare.com` and
`hope.ns.cloudflare.com`.

Cloudflare Email Sending automatically installed and public DNS resolved the
three `cf-bounce.xmtp.mx` MX records plus bounce SPF, DKIM, and apex DMARC.

Inbound Email Routing is enabled:

- apex MX points at Cloudflare's three `route*.mx.cloudflare.net` hosts;
- apex SPF and `cf2024-1._domainkey` DKIM exist on the authoritative nameserver;
- rule `56de1718b0074d839246aea6add9eb21` matches only
  `deanpierce.eth@xmtp.mx` and invokes `xmtp-mx-relay-edge`;
- rule `c6af7f7821494b47b7d978784b6c72d4` matches only
  `deanpierce@xmtp.mx` and invokes the same Worker;
- catch-all disabled with drop action;
- Worker `/healthz` returns HTTP 200.

The Worker allowlist contains exactly those two addresses. Neither creates a
job-level XMTP recipient override, so both resolve through
`XMTP_DEAN_ADDRESS=deanpierce.eth` and reach the same XMTP identity after the
listener is explicitly activated.

While the watchdog is paused or unconfigured, the Worker commits accepted SMTP
mail and its delivery job to D1 with status `received` without publishing to
Queue. Explicit XMTP activation causes the watchdog to publish held jobs.

An authenticated external DATA acceptance and matching D1 row are still
required for the live SMTP receipt. Cloudflare accepted the address at RCPT;
unauthenticated direct DATA probes were correctly rejected by SPF/DMARC, and a
same-domain Email Sending message is not an independent routing test.

## Deployment gates

GitHub environment `cloudflare-relay-production` is restricted to `main` and
requires owner review. `CLOUDFLARE_RELAY_RESOURCES_PROVISIONED=true`; the source
export, R2 snapshot, legacy-listener-stopped, and activation-approval gates are
explicitly `false`. The user-approved paused-deploy gate is `true`, and the
verified Worker URL is recorded.

The existing-production source snapshot and expected installation identity
remain required before the XMTP Container may be activated. No new XMTP
installation is authorized by this receipt.
