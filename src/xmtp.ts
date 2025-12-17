import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client, IdentifierKind, generateInboxId, type Identifier, type Signer } from '@xmtp/node-sdk';
import { ethers } from 'ethers';
import type { XmtpEnv } from './xmtpEnv';

const DEFAULT_MAINNET_RPC_URL = 'https://ethereum.publicnode.com';

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

  const inboxIdHint = generateInboxId(identifier);
  const dbPath = path.join(args.dataDir, `xmtp-${args.env}-${inboxIdHint}.db3`);

  return Client.create(signer, {
    env: args.env,
    dbPath,
    dbEncryptionKey: deriveDbEncryptionKey(privateKeyHex),
  });
}

export async function getInboxIdByAddress(args: { xmtp: Client; address: string }): Promise<string> {
  const inboxId = await args.xmtp.getInboxIdByIdentifier(makeEthereumIdentifier(args.address));
  if (!inboxId) {
    throw new Error(`No XMTP inbox found for address: ${args.address}`);
  }
  return inboxId;
}
