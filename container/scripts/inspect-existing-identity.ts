import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Client,
  IdentifierKind,
  getInboxIdForIdentifier,
  type Identifier,
  type Signer,
} from '@xmtp/node-sdk';
import { ethers } from 'ethers';
import { PINNED_INBOX_FILENAME, databasePath } from '../src/snapshot.js';

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    return value;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required option --${name}`);
}

function normalizePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('XMTP_BOT_KEY is required in the environment');
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

async function assertNoSidecars(dbPath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      const details = await fs.stat(`${dbPath}${suffix}`);
      if (details.size > 0) {
        throw new Error(
          `${path.basename(dbPath)}${suffix} is nonempty; the legacy relay may still be running or did not exit cleanly`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function main(): Promise<void> {
  if (option('confirm-relay-stopped') !== 'yes') {
    throw new Error('Pass --confirm-relay-stopped yes only after the Railway relay process is fully stopped');
  }
  const dataDir = path.resolve(option('data-dir'));
  const xmtpEnv = option('xmtp-env', 'production');
  if (xmtpEnv !== 'production' && xmtpEnv !== 'dev' && xmtpEnv !== 'local') {
    throw new Error('--xmtp-env must be production, dev, or local');
  }
  const pinnedInboxId = (await fs.readFile(path.join(dataDir, PINNED_INBOX_FILENAME), 'utf8'))
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pinnedInboxId)) throw new Error('Pinned XMTP inbox ID is invalid');
  const dbPath = databasePath(dataDir, xmtpEnv, pinnedInboxId);
  const dbDetails = await fs.stat(dbPath);
  if (!dbDetails.isFile() || dbDetails.size === 0) throw new Error(`XMTP database is missing or empty: ${dbPath}`);
  await assertNoSidecars(dbPath);

  const privateKey = normalizePrivateKey(process.env.XMTP_BOT_KEY ?? '');
  const wallet = new ethers.Wallet(privateKey);
  const identifier: Identifier = {
    identifier: ethers.utils.getAddress(wallet.address),
    identifierKind: IdentifierKind.Ethereum,
  };
  const networkInboxId = (await getInboxIdForIdentifier(identifier, xmtpEnv))?.toLowerCase();
  if (!networkInboxId || networkInboxId !== pinnedInboxId) {
    throw new Error(
      `Wallet/network inbox ${networkInboxId ?? 'missing'} does not match pinned inbox ${pinnedInboxId}`,
    );
  }
  const signer: Signer = {
    type: 'EOA',
    signMessage: async (message) => ethers.utils.arrayify(await wallet.signMessage(message)),
    getIdentifier: () => identifier,
  };

  const client = await Client.create(signer, {
    env: xmtpEnv,
    dbPath,
    dbEncryptionKey: crypto.createHash('sha256').update(ethers.utils.arrayify(privateKey)).digest(),
    disableAutoRegister: true,
  });
  if (client.inboxId.toLowerCase() !== pinnedInboxId) throw new Error('Client.inboxId differs from pin');
  if (!client.isRegistered) {
    throw new Error('Existing database does not report a registered installation; no registration was attempted');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        autoRegister: false,
        registerCalled: false,
        inboxId: client.inboxId.toLowerCase(),
        installationId: client.installationId,
        database: dbPath,
      },
      null,
      2,
    )}\n`,
  );
  // @xmtp/node-sdk 3.2.2 has no Client.close(). Exiting this dedicated
  // diagnostic process closes the only handle before snapshot:export runs.
  setTimeout(() => process.exit(0), 25);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  setTimeout(() => process.exit(1), 25);
});
