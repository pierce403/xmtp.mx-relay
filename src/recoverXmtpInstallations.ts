import * as dotenv from 'dotenv';
import { emergencyRevokeInstallationsForWallet } from './xmtp';
import type { XmtpEnv } from './xmtpEnv';

dotenv.config();

function parseXmtpEnv(value: string | undefined): XmtpEnv {
  if (value === 'dev' || value === 'local' || value === 'production') return value;
  return 'production';
}

function parseKeepCount(value: string | undefined): number {
  const parsed = Number.parseInt((value || '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 1;
}

async function main(): Promise<void> {
  const env = parseXmtpEnv(process.env.XMTP_ENV);
  const privateKey = (process.env.XMTP_BOT_KEY || process.env.XMTP_PRIVATE_KEY || '').trim();
  if (!privateKey) {
    throw new Error('Missing env var: XMTP_BOT_KEY (or XMTP_PRIVATE_KEY)');
  }

  const keep = parseKeepCount(process.env.XMTP_REVOKE_KEEP_INSTALLATIONS);
  const result = await emergencyRevokeInstallationsForWallet({ privateKey, env, keep });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
