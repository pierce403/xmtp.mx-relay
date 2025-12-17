import { Client } from '@xmtp/xmtp-js';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

const XMTP_TEST_SENDER_KEY = process.env.XMTP_TEST_SENDER_KEY || '';
if (!XMTP_TEST_SENDER_KEY) throw new Error('XMTP_TEST_SENDER_KEY is not set in the environment');

const XMTP_BOT_ADDRESS_OR_ENS = process.env.XMTP_BOT_ADDRESS_OR_ENS || '';
if (!XMTP_BOT_ADDRESS_OR_ENS) throw new Error('XMTP_BOT_ADDRESS_OR_ENS is not set in the environment');

const TEST_EMAIL_RECIPIENT = process.env.TEST_EMAIL_RECIPIENT || '';
if (!TEST_EMAIL_RECIPIENT) {
  throw new Error('TEST_EMAIL_RECIPIENT is not set in the environment');
}

type XmtpEnv = 'production' | 'dev' | 'local';
const XMTP_ENV: XmtpEnv = (() => {
  const env = process.env.XMTP_ENV;
  if (env === 'dev' || env === 'local' || env === 'production') {
    return env;
  }
  return 'production';
})();

const INFURA_KEY = process.env.INFURA_KEY;
const provider = INFURA_KEY
  ? new ethers.providers.JsonRpcProvider(`https://mainnet.infura.io/v3/${INFURA_KEY}`)
  : undefined;

async function resolveXmtpAddress(addressOrEns: string): Promise<string> {
  const trimmed = addressOrEns.trim();
  if (ethers.utils.isAddress(trimmed)) {
    return trimmed;
  }
  if (!trimmed.endsWith('.eth')) {
    throw new Error(`Invalid XMTP_SERVER_ADDRESS (expected 0x… address or .eth): ${addressOrEns}`);
  }
  if (!provider) {
    throw new Error('INFURA_KEY is required to resolve ENS names');
  }
  const resolved = await provider.resolveName(trimmed);
  if (!resolved) {
    throw new Error(`Failed to resolve ENS name: ${trimmed}`);
  }
  return resolved;
}

async function testXMTPIntegration() {
  const wallet = new ethers.Wallet(XMTP_TEST_SENDER_KEY);
  console.log(`Using sender wallet: ${wallet.address}`);

  const xmtp = await Client.create(wallet, { env: XMTP_ENV });
  console.log(`XMTP client ready (env=${XMTP_ENV})`);

  const botAddress = await resolveXmtpAddress(XMTP_BOT_ADDRESS_OR_ENS);
  console.log(`Sending to bot: ${XMTP_BOT_ADDRESS_OR_ENS} (${botAddress})`);

  const conversation = await xmtp.conversations.newConversation(botAddress);

  const payload = {
    type: 'email.send.v1',
    to: [TEST_EMAIL_RECIPIENT],
    cc: [],
    bcc: [],
    subject: 'Integration Test',
    text: 'Hello from test_integration.ts',
    html: null,
    replyTo: process.env.INBOUND_EMAIL_TO || null,
  };

  console.log('Sending email.send.v1 payload...');
  await conversation.send(JSON.stringify(payload));
  console.log('Sent. Check Mailgun logs for outgoing email + an XMTP result reply.');
}

testXMTPIntegration().catch((error) => {
  console.error('Integration test failed:', error);
  process.exitCode = 1;
});
