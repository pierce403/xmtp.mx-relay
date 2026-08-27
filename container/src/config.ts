import path from 'node:path';
import { z } from 'zod';

export const BOOTSTRAP_CONFIRMATION = 'I_UNDERSTAND_THIS_REGISTERS_A_NEW_XMTP_INSTALLATION';

const inboxIdSchema = z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-character XMTP inbox ID');

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http: or https:`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export type ContainerConfig = {
  port: number;
  dataDir: string;
  xmtpEnv: 'production' | 'dev' | 'local';
  xmtpBotKey: string;
  xmtpDeanAddressOrEns: string;
  xmtpExpectedInboxId: string | null;
  xmtpExpectedInstallationId: string | null;
  allowNewInstallation: boolean;
  bootstrapConfirmation: string | null;
  containerSharedSecret: string;
  snapshotSigningKey: string;
  edgeInternalUrl: string;
  r2InternalBaseUrl: string;
  r2Prefix: string;
  backupIntervalMs: number;
  backupMaxStalenessMs: number;
  backupPartBytes: number;
  freeSpaceMarginBytes: number;
  maxRequestBodyBytes: number;
  maxBackupBytes: number;
  maxXmtpContentBytes: number;
  catchupMessagesPerConversation: number;
  replayOverlapMs: number;
  ethRpcUrl: string;
  logLevel: string;
  bootGeneration: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ContainerConfig {
  const schema = z.object({
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    DATA_DIR: z.string().default('/data'),
    XMTP_ENV: z.enum(['production', 'dev', 'local']).default('production'),
    XMTP_BOT_KEY: z.string().min(1),
    XMTP_DEAN_ADDRESS: z.string().min(1),
    XMTP_EXPECTED_INBOX_ID: inboxIdSchema.optional(),
    XMTP_EXPECTED_INSTALLATION_ID: z.string().min(1).max(512).optional(),
    XMTP_ALLOW_NEW_INSTALLATION: z.string().optional(),
    XMTP_BOOTSTRAP_CONFIRM: z.string().optional(),
    XMTP_EMERGENCY_REVOKE_INSTALLATIONS: z.string().optional(),
    CONTAINER_SHARED_SECRET: z.string().min(32),
    XMTP_SNAPSHOT_SIGNING_KEY: z.string().trim().min(32),
    EDGE_INTERNAL_URL: z.string().default('http://xmtp-edge.internal'),
    R2_INTERNAL_BASE_URL: z.string().default('http://xmtp-r2.internal'),
    XMTP_R2_PREFIX: z.string().default('xmtp-mx-relay-production/xmtp'),
    XMTP_BACKUP_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
    XMTP_BACKUP_MAX_STALENESS_SECONDS: z.coerce.number().int().min(120).max(172_800).default(7_200),
    XMTP_BACKUP_PART_BYTES: z.coerce.number().int().min(1024 * 1024).max(32 * 1024 * 1024).default(16 * 1024 * 1024),
    XMTP_FREE_SPACE_MARGIN_BYTES: z.coerce.number().int().min(16 * 1024 * 1024).max(5 * 1024 * 1024 * 1024).default(64 * 1024 * 1024),
    MAX_INTERNAL_REQUEST_BYTES: z.coerce.number().int().min(1_024).max(5 * 1024 * 1024).default(512 * 1024),
    XMTP_MAX_BACKUP_BYTES: z.coerce.number().int().min(1024 * 1024).max(5 * 1024 * 1024 * 1024).default(1024 * 1024 * 1024),
    MAX_XMTP_CONTENT_BYTES: z.coerce.number().int().min(1_024).max(1024 * 1024).default(256 * 1024),
    XMTP_CATCHUP_MESSAGES_PER_CONVERSATION: z.coerce.number().int().min(1).max(50_000).default(10_000),
    XMTP_REPLAY_OVERLAP_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
    ETH_RPC_URL: z.string().default('https://ethereum.publicnode.com'),
    LOG_LEVEL: z.string().default('info'),
    CONTAINER_BOOT_GENERATION: z.string().optional(),
  });

  const parsed = schema.parse(env);
  const allowNewInstallation = parseBoolean(parsed.XMTP_ALLOW_NEW_INSTALLATION, false);
  const emergencyRevoke = parseBoolean(parsed.XMTP_EMERGENCY_REVOKE_INSTALLATIONS, false);

  if (emergencyRevoke) {
    throw new Error(
      'XMTP_EMERGENCY_REVOKE_INSTALLATIONS is forbidden in the Cloudflare Container; recovery must restore the existing installation.',
    );
  }

  if (parsed.XMTP_ENV === 'production' && !parsed.XMTP_EXPECTED_INBOX_ID) {
    throw new Error('XMTP_EXPECTED_INBOX_ID is required in production');
  }
  if (
    parsed.XMTP_ENV === 'production' &&
    !allowNewInstallation &&
    !parsed.XMTP_EXPECTED_INSTALLATION_ID
  ) {
    throw new Error('XMTP_EXPECTED_INSTALLATION_ID is required for normal production recovery');
  }

  const bootstrapConfirmation = parsed.XMTP_BOOTSTRAP_CONFIRM?.trim() || null;
  if (allowNewInstallation && bootstrapConfirmation !== BOOTSTRAP_CONFIRMATION) {
    throw new Error(
      `XMTP_ALLOW_NEW_INSTALLATION=true requires XMTP_BOOTSTRAP_CONFIRM=${BOOTSTRAP_CONFIRMATION}`,
    );
  }

  const r2Prefix = parsed.XMTP_R2_PREFIX.replace(/^\/+|\/+$/g, '');
  if (!r2Prefix || r2Prefix.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('XMTP_R2_PREFIX must be a non-empty safe object-key prefix');
  }

  const dataDir = path.resolve(parsed.DATA_DIR);
  if (dataDir === path.parse(dataDir).root) {
    throw new Error('DATA_DIR cannot be a filesystem root');
  }
  if (parsed.XMTP_BACKUP_PART_BYTES > parsed.XMTP_MAX_BACKUP_BYTES) {
    throw new Error('XMTP_BACKUP_PART_BYTES cannot exceed XMTP_MAX_BACKUP_BYTES');
  }

  return {
    port: parsed.PORT,
    dataDir,
    xmtpEnv: parsed.XMTP_ENV,
    xmtpBotKey: parsed.XMTP_BOT_KEY.trim(),
    xmtpDeanAddressOrEns: parsed.XMTP_DEAN_ADDRESS.trim(),
    xmtpExpectedInboxId: parsed.XMTP_EXPECTED_INBOX_ID?.toLowerCase() ?? null,
    xmtpExpectedInstallationId: parsed.XMTP_EXPECTED_INSTALLATION_ID?.trim() || null,
    allowNewInstallation,
    bootstrapConfirmation,
    containerSharedSecret: parsed.CONTAINER_SHARED_SECRET,
    snapshotSigningKey: parsed.XMTP_SNAPSHOT_SIGNING_KEY,
    edgeInternalUrl: parseUrl('EDGE_INTERNAL_URL', parsed.EDGE_INTERNAL_URL),
    r2InternalBaseUrl: parseUrl('R2_INTERNAL_BASE_URL', parsed.R2_INTERNAL_BASE_URL),
    r2Prefix,
    backupIntervalMs: parsed.XMTP_BACKUP_INTERVAL_SECONDS * 1_000,
    backupMaxStalenessMs: parsed.XMTP_BACKUP_MAX_STALENESS_SECONDS * 1_000,
    backupPartBytes: parsed.XMTP_BACKUP_PART_BYTES,
    freeSpaceMarginBytes: parsed.XMTP_FREE_SPACE_MARGIN_BYTES,
    maxRequestBodyBytes: parsed.MAX_INTERNAL_REQUEST_BYTES,
    maxBackupBytes: parsed.XMTP_MAX_BACKUP_BYTES,
    maxXmtpContentBytes: parsed.MAX_XMTP_CONTENT_BYTES,
    catchupMessagesPerConversation: parsed.XMTP_CATCHUP_MESSAGES_PER_CONVERSATION,
    replayOverlapMs: parsed.XMTP_REPLAY_OVERLAP_SECONDS * 1_000,
    ethRpcUrl: parsed.ETH_RPC_URL,
    logLevel: parsed.LOG_LEVEL,
    bootGeneration: parsed.CONTAINER_BOOT_GENERATION?.trim() || null,
  };
}
