type XmtpEnv = 'production' | 'dev' | 'local';

interface Env {
  // Secrets (set via `wrangler secret put ...`)
  XMTP_PRIVATE_KEY: string;
  MAILGUN_API_KEY: string;

  // Vars (set via `wrangler.toml` [vars] or Secrets)
  MAILGUN_DOMAIN: string;
  XMTP_ENV?: XmtpEnv;
  ADMIN_XMTP_ADDRESS?: string;

  // Bindings
  STATE: KVNamespace;
}

type RelayStateV1 = {
  lastProcessedTimeMs: number;
  processedIds: string[];
};

const STATE_KEY = 'relay_state_v1';
const INITIAL_LOOKBACK_MS = 15 * 60_000;
const OVERLAP_MS = 30_000;

function requireEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim() || '';
  if (!trimmed) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return trimmed;
}

function normalizeXmtpEnv(value: string | undefined): XmtpEnv {
  if (value === 'dev' || value === 'local' || value === 'production') return value;
  return 'production';
}

function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function toBase64(value: string): string {
  // Prefer btoa (Workers), fallback to Buffer (nodejs_compat).
  if (typeof btoa === 'function') return btoa(value);
  // eslint-disable-next-line no-undef
  return Buffer.from(value).toString('base64');
}

async function loadState(env: Env): Promise<RelayStateV1 | null> {
  const raw = await env.STATE.get(STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RelayStateV1>;
    return {
      lastProcessedTimeMs: typeof parsed.lastProcessedTimeMs === 'number' ? parsed.lastProcessedTimeMs : 0,
      processedIds: Array.isArray(parsed.processedIds) ? parsed.processedIds.filter((id) => typeof id === 'string') : [],
    };
  } catch {
    return null;
  }
}

async function saveState(env: Env, state: RelayStateV1): Promise<void> {
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
}

function normalizeEmailRecipient(to: string, mailgunDomain: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error('Missing recipient in "To:" line');
  }

  // Allow direct email addresses (e.g. alice@example.com, alice.eth@xmtp.mx).
  if (trimmed.includes('@')) {
    return trimmed;
  }

  // Convenience: allow ENS name local-part (e.g. alice.eth) and map to alice.eth@<MAILGUN_DOMAIN>.
  if (trimmed.endsWith('.eth')) {
    return `${trimmed}@${mailgunDomain}`;
  }

  throw new Error('Invalid recipient in "To:" line (expected an email address or ENS name)');
}

function parseXmtpEmailMessage(
  content: string,
  mailgunDomain: string,
): { to: string; subject: string; body: string } {
  const lines = content.split(/\r?\n/);
  let to = '';
  let subject = '';
  const bodyLines: string[] = [];
  let isBody = false;

  for (const line of lines) {
    if (!isBody) {
      if (line.trim() === '') {
        isBody = true;
        continue;
      }

      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (!match) continue;

      const key = match[1]?.trim().toLowerCase();
      const value = match[2]?.trim() || '';

      if (key === 'to') to = value;
      else if (key === 'subject') subject = value;

      continue;
    }

    bodyLines.push(line);
  }

  if (!to) {
    throw new Error('Missing "To:" line in the XMTP message');
  }

  return { to: normalizeEmailRecipient(to, mailgunDomain), subject, body: bodyLines.join('\n').trim() };
}

async function sendMailgunEmail(env: Env, to: string, subject: string, body: string): Promise<void> {
  const mailgunDomain = requireEnv(env.MAILGUN_DOMAIN, 'MAILGUN_DOMAIN');
  const apiKey = requireEnv(env.MAILGUN_API_KEY, 'MAILGUN_API_KEY');

  const form = new FormData();
  form.set('from', `XMTP-MX Server <noreply@${mailgunDomain}>`);
  form.set('to', to);
  form.set('subject', subject || '(no subject)');
  form.set('text', body);

  const response = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${toBase64(`api:${apiKey}`)}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Mailgun send failed (${response.status}): ${text}`);
  }
}

function formatParseError(errorMessage: string): string {
  return [
    'Error processing your message.',
    '',
    errorMessage,
    '',
    'Expected format:',
    'To: recipient@example.com',
    'Subject: Optional subject',
    '',
    'Body goes here...',
  ].join('\n');
}

async function createXmtpClient(env: Env) {
  // The XMTP browser/bundler build expects `window.crypto`.
  // Workers have `crypto`, but not `window`.
  (globalThis as unknown as { window?: unknown }).window = globalThis;

  const [{ Client, InMemoryPersistence }, { privateKeyToAccount }] = await Promise.all([
    import('@xmtp/xmtp-js/browser/bundler'),
    import('viem/accounts'),
  ]);

  const rawPk = requireEnv(env.XMTP_PRIVATE_KEY, 'XMTP_PRIVATE_KEY');
  const pk = (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);

  const signer = {
    getAddress: async () => account.address,
    signMessage: async (message: ArrayLike<number> | string) => {
      if (typeof message === 'string') {
        return account.signMessage({ message });
      }
      const bytes = Uint8Array.from(message as ArrayLike<number>);
      return account.signMessage({ message: { raw: bytes } });
    },
  };

  const xmtp = await Client.create(signer, {
    env: normalizeXmtpEnv(env.XMTP_ENV),
    persistence: new InMemoryPersistence(),
  });

  return xmtp;
}

async function sendXmtpText(xmtp: any, to: string, content: string): Promise<void> {
  if (!isHexAddress(to)) {
    console.warn(`Skipping XMTP send (expected 0x… address): ${to}`);
    return;
  }
  try {
    const convo = await xmtp.conversations.newConversation(to);
    await convo.send(content);
  } catch (error) {
    console.warn(`Failed to send XMTP message to ${to}:`, error);
  }
}

async function runRelay(env: Env): Promise<void> {
  const mailgunDomain = requireEnv(env.MAILGUN_DOMAIN, 'MAILGUN_DOMAIN');

  const state = (await loadState(env)) ?? { lastProcessedTimeMs: 0, processedIds: [] };
  const now = Date.now();
  const baseStart = state.lastProcessedTimeMs > 0 ? state.lastProcessedTimeMs : now - INITIAL_LOOKBACK_MS;
  const startTime = new Date(baseStart - OVERLAP_MS);

  const xmtp = await createXmtpClient(env);
  try {
    const conversations = await xmtp.conversations.list();
    const allMessages: any[] = [];

    for (const conversation of conversations) {
      const messages = await conversation.messages({ startTime });
      for (const message of messages) {
        // Only process inbound messages.
        if (message.senderAddress?.toLowerCase() === xmtp.address.toLowerCase()) continue;
        allMessages.push(message);
      }
    }

    allMessages.sort((a, b) => new Date(a.sent).getTime() - new Date(b.sent).getTime());

    let processedCount = 0;
    for (const message of allMessages) {
      const sentMs = new Date(message.sent).getTime();
      if (sentMs < state.lastProcessedTimeMs) continue;
      if (sentMs === state.lastProcessedTimeMs && state.processedIds.includes(message.id)) continue;

      try {
        const parsed = parseXmtpEmailMessage(String(message.content ?? ''), mailgunDomain);
        await sendMailgunEmail(env, parsed.to, parsed.subject, parsed.body);
        processedCount += 1;
        console.log(`Relayed XMTP ${message.id} -> email ${parsed.to}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const reply = formatParseError(errorMessage);

        // Reply to the sender in the same conversation.
        try {
          await message.conversation.send(reply);
        } catch (sendError) {
          console.warn(`Failed to reply to sender for message ${message.id}:`, sendError);
        }

        if (env.ADMIN_XMTP_ADDRESS) {
          await sendXmtpText(xmtp, env.ADMIN_XMTP_ADDRESS, `Relay error:\n\n${reply}`);
        }
      }

      if (sentMs > state.lastProcessedTimeMs) {
        state.lastProcessedTimeMs = sentMs;
        state.processedIds = [message.id];
      } else {
        state.processedIds.push(message.id);
      }
    }

    if (processedCount === 0 && state.lastProcessedTimeMs === 0) {
      // First run & nothing to do: avoid scanning the same window again.
      state.lastProcessedTimeMs = now;
      state.processedIds = [];
    }

    await saveState(env, state);
  } finally {
    await xmtp.close().catch(() => undefined);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRelay(env));
  },
  async fetch(_request: Request): Promise<Response> {
    return new Response('ok');
  },
};

