-- Seed this before the first pre-MX Worker deployment. It prevents the Cron
-- watchdog from starting a second XMTP listener while Railway is still live.
INSERT INTO relay_state(key, value, updated_at)
VALUES (
  'watchdog_pause',
  '{"paused":true,"at":"' || strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || '","reason":"pre_mx_deploy"}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
