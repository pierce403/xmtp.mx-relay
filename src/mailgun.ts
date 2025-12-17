import crypto from 'node:crypto';

export function verifyMailgunWebhookSignature(args: {
  signingKey: string;
  timestamp: string;
  token: string;
  signature: string;
}): boolean {
  const computed = crypto
    .createHmac('sha256', args.signingKey)
    .update(`${args.timestamp}${args.token}`)
    .digest('hex');

  // Constant-time compare.
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(args.signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractEmailAddress(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/<([^>]+@[^>]+)>/);
  if (match?.[1]) return match[1].trim();
  return trimmed.split(',')[0]?.trim() || '';
}

export type MailgunInboundEmail = {
  from: string;
  to: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  messageId: string | null;
  mailgunMessageId: string | null;
};

export function normalizeMailgunInbound(fields: Record<string, string | undefined>): MailgunInboundEmail {
  const from =
    extractEmailAddress(fields.sender || '') ||
    extractEmailAddress(fields.from || '') ||
    extractEmailAddress(fields.From || '');

  const to =
    extractEmailAddress(fields.recipient || '') ||
    extractEmailAddress(fields.to || '') ||
    extractEmailAddress(fields.To || '');

  return {
    from,
    to,
    subject: fields.subject?.trim() || null,
    text: fields['body-plain'] ?? fields.text ?? null,
    html: fields['body-html'] ?? fields.html ?? null,
    // Prefer explicit Mailgun id if present, but keep the RFC Message-Id as messageId.
    mailgunMessageId: fields['message-id']?.trim() || null,
    messageId: fields['Message-Id']?.trim() || fields['message-id']?.trim() || null,
  };
}
