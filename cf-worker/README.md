# Cloudflare Worker (scheduled poller)

Cloudflare Workers are request/schedule driven and can’t keep an always-on XMTP stream open like the Node script does. This Worker version runs on a cron and **polls for new XMTP messages**, then forwards them to Mailgun.

Expect ~1 minute latency (or whatever you set in the cron), and make sure you’re OK with polling semantics.

## Setup

1. Install deps (from repo root):

```
npm install
```

2. Install/login to Wrangler (if needed):

```
npx wrangler login
```

3. Create the KV namespace used for cursor/state:

```
npx wrangler kv namespace create STATE --config cf-worker/wrangler.toml
npx wrangler kv namespace create STATE --preview --config cf-worker/wrangler.toml
```

Copy the returned `id`/`preview_id` into `cf-worker/wrangler.toml`.

4. Set secrets:

```
npx wrangler secret put XMTP_PRIVATE_KEY --config cf-worker/wrangler.toml
npx wrangler secret put MAILGUN_API_KEY --config cf-worker/wrangler.toml
```

5. Set non-secret vars in `cf-worker/wrangler.toml`:

- `MAILGUN_DOMAIN`
- `XMTP_ENV` (`production`, `dev`, or `local`)
- `ADMIN_XMTP_ADDRESS` (optional; **0x… address only** in the Worker version)

## Local dev

Run a local dev session and simulate the cron:

```
npx wrangler dev --test-scheduled --config cf-worker/wrangler.toml
```

## Deploy

```
npx wrangler deploy --config cf-worker/wrangler.toml
```

## Notes

- State is stored under the KV key `relay_state_v1` to avoid duplicate processing across runs.
- On the first run, the Worker only looks back `INITIAL_LOOKBACK_MS` (currently 15 minutes) to avoid blasting old message history.
