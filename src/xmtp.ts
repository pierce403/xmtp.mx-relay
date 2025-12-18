import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Client,
  IdentifierKind,
  generateInboxId,
  getInboxIdForIdentifier,
  type Identifier,
  type Signer,
} from '@xmtp/node-sdk';
import { ethers } from 'ethers';
import type { XmtpEnv } from './xmtpEnv';
import { log } from './log';

const DEFAULT_MAINNET_RPC_URL = 'https://ethereum.publicnode.com';
const PINNED_INBOX_ID_FILENAME = 'xmtp-inbox-id.txt';

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
}

export function normalizeXmtpEnv(value: string | undefined): XmtpEnv {
  if (value === 'dev' || value === 'local' || value === 'production') return value;
  return 'production';
}

export function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function createEnsProvider(ethRpcUrl: string | null): ethers.providers.Provider {
  const rpcUrl = ethRpcUrl?.trim() || DEFAULT_MAINNET_RPC_URL;
  return new ethers.providers.JsonRpcProvider(rpcUrl, { name: 'homestead', chainId: 1 });
}

function normalizePrivateKey(privateKey: string): string {
  const trimmed = privateKey.trim();
  if (!trimmed) throw new Error('XMTP private key is empty');
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function makeEthereumIdentifier(address: string): Identifier {
  return { identifier: ethers.utils.getAddress(address), identifierKind: IdentifierKind.Ethereum };
}

function deriveDbEncryptionKey(privateKeyHex: string): Uint8Array {
  const pkBytes = ethers.utils.arrayify(privateKeyHex);
  return crypto.createHash('sha256').update(pkBytes).digest();
}

function getPinnedInboxIdPath(dataDir: string): string {
  return path.join(dataDir, PINNED_INBOX_ID_FILENAME);
}

function readPinnedInboxId(dataDir: string): string | null {
  try {
    const value = fs.readFileSync(getPinnedInboxIdPath(dataDir), 'utf8').trim();
    return value || null;
  } catch (error) {
    const err = error as { code?: unknown } | null;
    if (err?.code === 'ENOENT') return null;
    throw error;
  }
}

function ensurePinnedInboxId(dataDir: string, inboxId: string): void {
  const existing = readPinnedInboxId(dataDir);
  if (!existing) {
    fs.writeFileSync(getPinnedInboxIdPath(dataDir), `${inboxId}\n`, 'utf8');
    return;
  }
  if (existing !== inboxId) {
    throw new Error(
      [
        'XMTP inbox ID mismatch.',
        `Pinned: ${existing}`,
        `Actual: ${inboxId}`,
        `If you intentionally rotated keys, delete ${getPinnedInboxIdPath(dataDir)}.`,
      ].join('\n'),
    );
  }
}

function isMaxInstallationsError(error: unknown): { inboxId: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/InboxID\s+([0-9a-f]{64})/i);
  if (!match) return null;
  if (!message.toLowerCase().includes('installations')) return null;
  return { inboxId: match[1] };
}

export async function revokeOtherInstallationsForInbox(args: {
  signer: Signer;
  env: XmtpEnv;
  inboxId: string;
  keep: number;
}): Promise<{ total: number; revoked: number; kept: number }> {
  const states = await Client.inboxStateFromInboxIds([args.inboxId], args.env);
  const state = states[0];
  if (!state) {
    throw new Error(`Inbox not found: ${args.inboxId}`);
  }

  const installations = state.installations ?? [];
  const total = installations.length;
  const keep = Math.max(0, Math.min(args.keep, total));
  const toRevoke = installations.slice(keep).map((installation) => installation.bytes);

  if (toRevoke.length > 0) {
    await Client.revokeInstallations(args.signer, args.inboxId, toRevoke, args.env);
  }

  return { total, revoked: toRevoke.length, kept: keep };
}

export async function emergencyRevokeInstallationsForWallet(args: {
  privateKey: string;
  env: XmtpEnv;
  keep: number;
}): Promise<{ inboxId: string; total: number; revoked: number; kept: number }> {
  const privateKeyHex = normalizePrivateKey(args.privateKey);
  const wallet = new ethers.Wallet(privateKeyHex);
  const identifier = makeEthereumIdentifier(wallet.address);

  const signer: Signer = {
    type: 'EOA',
    signMessage: async (message) => ethers.utils.arrayify(await wallet.signMessage(message)),
    getIdentifier: () => identifier,
  };

  const inboxId = (await getInboxIdForIdentifier(identifier, args.env)) || generateInboxId(identifier);
  const result = await revokeOtherInstallationsForInbox({
    signer,
    env: args.env,
    inboxId,
    keep: args.keep,
  });

  return { inboxId, ...result };
}

export async function resolveXmtpAddress(
  addressOrEns: string,
  provider: ethers.providers.Provider,
): Promise<string> {
  const trimmed = addressOrEns.trim();
  if (ethers.utils.isAddress(trimmed)) return ethers.utils.getAddress(trimmed);
  if (!trimmed.endsWith('.eth')) {
    throw new Error(`Invalid XMTP address (expected 0x… address or .eth): ${addressOrEns}`);
  }
  const resolved = await provider.resolveName(trimmed);
  if (!resolved) {
    throw new Error(`Failed to resolve ENS name: ${trimmed}`);
  }
  return ethers.utils.getAddress(resolved);
}

export async function createXmtpClient(args: {
  privateKey: string;
  env: XmtpEnv;
  dataDir: string;
}): Promise<Client> {
  fs.mkdirSync(args.dataDir, { recursive: true });

  const privateKeyHex = normalizePrivateKey(args.privateKey);
  const wallet = new ethers.Wallet(privateKeyHex);
  const identifier = makeEthereumIdentifier(wallet.address);

  const signer: Signer = {
    type: 'EOA',
    signMessage: async (message) => ethers.utils.arrayify(await wallet.signMessage(message)),
    getIdentifier: () => identifier,
  };

  const allowNewInstallation = isTruthyEnv(process.env.XMTP_ALLOW_NEW_INSTALLATION);
  const emergencyRevokeInstallations = isTruthyEnv(process.env.XMTP_EMERGENCY_REVOKE_INSTALLATIONS);
  const enforceSingleInstallation = isTruthyEnv(process.env.XMTP_ENFORCE_SINGLE_INSTALLATION);

  const pinnedInboxId = readPinnedInboxId(args.dataDir);
  const inboxIdHint = pinnedInboxId || generateInboxId(identifier);
  const dbPath = path.join(args.dataDir, `xmtp-${args.env}-${inboxIdHint}.db3`);

  if (args.env === 'production' && !fs.existsSync(dbPath) && !allowNewInstallation) {
    throw new Error(
      [
        'Refusing to register a new XMTP installation in production because no local XMTP DB was found.',
        `Expected file: ${dbPath}`,
        '',
        'This usually means your DATA_DIR is not on a persistent volume, and each deploy would burn a new installation slot.',
        'Fix: mount a persistent volume and set DATA_DIR=/data (Railway), then redeploy.',
        '',
        'If this is the first-ever production deploy, set XMTP_ALLOW_NEW_INSTALLATION=true for a single deploy.',
      ].join('\n'),
    );
  }

  try {
    const xmtp = await Client.create(signer, {
      env: args.env,
      dbPath,
      dbEncryptionKey: deriveDbEncryptionKey(privateKeyHex),
    });
    ensurePinnedInboxId(args.dataDir, xmtp.inboxId);
    if (enforceSingleInstallation) {
      try {
        await xmtp.revokeAllOtherInstallations();
      } catch (error) {
        log.warn({ error }, 'xmtp.revoke_all_other_installations_failed');
      }
    }
    return xmtp;
  } catch (error) {
    const maxInst = isMaxInstallationsError(error);
    if (maxInst && emergencyRevokeInstallations) {
      await revokeOtherInstallationsForInbox({
        signer,
        env: args.env,
        inboxId: maxInst.inboxId,
        keep: 1,
      });

      const xmtp = await Client.create(signer, {
        env: args.env,
        dbPath,
        dbEncryptionKey: deriveDbEncryptionKey(privateKeyHex),
      });
      ensurePinnedInboxId(args.dataDir, xmtp.inboxId);
      try {
        await xmtp.revokeAllOtherInstallations();
      } catch (error) {
        log.warn({ error }, 'xmtp.revoke_all_other_installations_failed');
      }
      return xmtp;
    }
    throw error;
  }
}

export async function getInboxIdByAddress(args: { xmtp: Client; address: string }): Promise<string> {
  const inboxId = await args.xmtp.getInboxIdByIdentifier(makeEthereumIdentifier(args.address));
  if (!inboxId) {
    throw new Error(`No XMTP inbox found for address: ${args.address}`);
  }
  return inboxId;
}
