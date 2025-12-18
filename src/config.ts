import path from 'node:path';
import { z } from 'zod';

const xmtpEnvSchema = z.enum(['production', 'dev', 'local']);

export type Config = {
  port: number;
  dataDir: string;
  inboundEmailTo: string;
  xmtpEnv: z.infer<typeof xmtpEnvSchema>;
  xmtpBotKey: string;
  xmtpDeanAddressOrEns: string;
  adminXmtpAddressOrEns: string | null;
  ethRpcUrl: string;
  mailgunApiKey: string;
  mailgunDomain: string;
  mailgunWebhookSigningKey: string;
  mailgunFrom: string;
  webhookRateLimit: { windowMs: number; max: number };
  maxInboundFieldSizeBytes: number;
};

export function loadConfig(): Config {
  const schema = z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATA_DIR: z.string().optional(),
    INBOUND_EMAIL_TO: z.string().default('deanpierce.eth@xmtp.mx'),

    XMTP_ENV: xmtpEnvSchema.default('production'),
    XMTP_BOT_KEY: z.string().optional(),
    XMTP_PRIVATE_KEY: z.string().optional(),
    XMTP_DEAN_ADDRESS: z.string().min(1),
    ADMIN_XMTP_ADDRESS: z.string().optional(),
    ETH_RPC_URL: z.string().optional(),

    MAILGUN_API_KEY: z.string().min(1),
    MAILGUN_DOMAIN: z.string().min(1),
    MAILGUN_WEBHOOK_SIGNING_KEY: z.string().min(1),
    MAILGUN_FROM: z.string().optional(),

    WEBHOOK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    MAX_INBOUND_FIELD_SIZE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  });

  const parsed = schema.parse(process.env);
  const dataDir = parsed.DATA_DIR?.trim() || path.join(process.cwd(), 'data');

  const xmtpBotKey = (parsed.XMTP_BOT_KEY || parsed.XMTP_PRIVATE_KEY || '').trim();
  if (!xmtpBotKey) {
    throw new Error('Missing env var: XMTP_BOT_KEY (or XMTP_PRIVATE_KEY)');
  }

  const ethRpcUrl = parsed.ETH_RPC_URL?.trim() || 'https://ethereum.publicnode.com';

  const mailgunFrom = parsed.MAILGUN_FROM?.trim() || `XMTP-MX Relay <noreply@${parsed.MAILGUN_DOMAIN}>`;

  return {
    port: parsed.PORT,
    dataDir,
    inboundEmailTo: parsed.INBOUND_EMAIL_TO.trim(),
    xmtpEnv: parsed.XMTP_ENV,
    xmtpBotKey,
    xmtpDeanAddressOrEns: parsed.XMTP_DEAN_ADDRESS.trim(),
    adminXmtpAddressOrEns: parsed.ADMIN_XMTP_ADDRESS?.trim() || null,
    ethRpcUrl,
    mailgunApiKey: parsed.MAILGUN_API_KEY.trim(),
    mailgunDomain: parsed.MAILGUN_DOMAIN.trim(),
    mailgunWebhookSigningKey: parsed.MAILGUN_WEBHOOK_SIGNING_KEY.trim(),
    mailgunFrom,
    webhookRateLimit: { windowMs: parsed.WEBHOOK_RATE_LIMIT_WINDOW_MS, max: parsed.WEBHOOK_RATE_LIMIT_MAX },
    maxInboundFieldSizeBytes: parsed.MAX_INBOUND_FIELD_SIZE_BYTES,
  };
}
