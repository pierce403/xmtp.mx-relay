# Cloudflare provisioning receipt — 2026-08-27

This receipt records the non-secret production resources created before the
XMTP identity handoff. It is not an activation or DNS cutover receipt.

## Source and validation

- Relay source: `e527470d1a104abf1ba5795d5e809e15a2540cef` on `main`
- GitHub validation: run `33078263656`, successful
- Cloudflare Worker unit tests: 33 passed
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

D1 migration `0001_cloudflare_relay.sql` was applied. The durable
`watchdog_pause` record was verified with `paused: true` and reason
`pre_mx_deploy` at `2026-08-27T13:43:15.361Z`.

## DNS state

Cloudflare is authoritative through `cash.ns.cloudflare.com` and
`hope.ns.cloudflare.com`.

Cloudflare Email Sending automatically installed and public DNS resolved the
three `cf-bounce.xmtp.mx` MX records plus bounce SPF, DKIM, and apex DMARC.

Inbound Email Routing remains deliberately disabled:

- no custom Email Routing rules;
- catch-all disabled with drop action;
- no apex `xmtp.mx` MX records;
- no apex Email Routing SPF or `cf2024-1._domainkey` record.

Do not enable the apex MX records until a paused Worker is deployed, its exact
Email Routing rule targets `xmtp-mx-relay-edge`, the restored XMTP identity is
verified, and the listener handoff gates pass.

## Deployment gates

GitHub environment `cloudflare-relay-production` is restricted to `main` and
requires owner review. `CLOUDFLARE_RELAY_RESOURCES_PROVISIONED=true`; the source
export, paused-deploy approval, R2 snapshot, legacy-listener-stopped, and
activation-approval gates are explicitly `false`.

The `xmtp-mx-relay-edge` Worker is not deployed. Cloudflare returned code
`10007` when its deployments were queried. The existing-production source
snapshot and expected installation identity remain required before the
checked-in `deploy-paused` workflow may run.
