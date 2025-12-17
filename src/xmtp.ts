import { Client } from '@xmtp/xmtp-js';
import { ethers } from 'ethers';
import type { XmtpEnv } from './xmtpEnv';
import type { Persistence } from '@xmtp/xmtp-js';

export type { Persistence };

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
  basePersistence: Persistence;
}): Promise<Client> {
  const pk = args.privateKey.startsWith('0x') ? args.privateKey : `0x${args.privateKey}`;
  const wallet = new ethers.Wallet(pk);
  return Client.create(wallet, {
    env: args.env,
    basePersistence: args.basePersistence,
  });
}
