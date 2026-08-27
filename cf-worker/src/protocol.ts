export const EMAIL_SEND_V1 = 'email.send.v1' as const;
export const EMAIL_INBOUND_V1 = 'email.inbound.v1' as const;
export const EMAIL_SEND_RESULT_V1 = 'email.send.result.v1' as const;

const EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const ALLOWED_SEND_KEYS = new Set([
  'type',
  'to',
  'cc',
  'bcc',
  'subject',
  'text',
  'html',
  'replyTo',
]);

export type EmailSendV1 = {
  type: typeof EMAIL_SEND_V1;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  replyTo: string | null;
};

export type EmailInboundV1 = {
  type: typeof EMAIL_INBOUND_V1;
  to: string;
  from: string;
  subject: string;
  text: string | null;
  html: string | null;
  messageId: string | null;
  receivedAt: string;
};

/** Provider-neutral ID returned by Cloudflare Email Service. */
export type EmailSendResultV1 = {
  type: typeof EMAIL_SEND_RESULT_V1;
  ok: boolean;
  providerMessageId: string | null;
  error: string | null;
};

export type XmtpEvent = {
  messageId: string;
  senderInboxId: string;
  conversationId: string;
  content: string;
  receivedAt: string;
};

export type EmailDeliveryQueueMessage = {
  version: 1;
  kind: 'email_delivery';
  xmtpMessageId: string;
};

export type XmtpDeliveryQueueMessage = {
  version: 1;
  kind: 'xmtp_delivery';
  jobId: string;
};

export type QueueMessage = EmailDeliveryQueueMessage | XmtpDeliveryQueueMessage;

export type ContainerDeliveryRequest = {
  jobId: string;
  kind: typeof EMAIL_INBOUND_V1 | typeof EMAIL_SEND_RESULT_V1;
  payload: EmailInboundV1 | EmailSendResultV1;
  conversationId?: string;
  recipientInboxId?: string;
  senderInboxId?: string;
};

export class InputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InputError';
  }
}

export function parseXmtpEvent(input: unknown, maxContentBytes: number): XmtpEvent {
  const value = requireRecord(input, 'invalid_event');
  const allowed = new Set(['messageId', 'senderInboxId', 'conversationId', 'content', 'receivedAt']);
  rejectUnknownKeys(value, allowed, 'invalid_event');

  const messageId = requireBoundedString(value.messageId, 'messageId', 512);
  const senderInboxId = requireBoundedString(value.senderInboxId, 'senderInboxId', 256).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(senderInboxId)) {
    throw new InputError('invalid_event', 'senderInboxId must be a 64-hex XMTP inbox ID');
  }
  const conversationId = requireBoundedString(value.conversationId, 'conversationId', 512);
  const content = requireBoundedString(value.content, 'content', maxContentBytes, true);
  const receivedAt = requireBoundedString(value.receivedAt, 'receivedAt', 64);
  if (Number.isNaN(Date.parse(receivedAt))) {
    throw new InputError('invalid_event', 'receivedAt must be an ISO-8601 timestamp');
  }

  return { messageId, senderInboxId, conversationId, content, receivedAt };
}

export function parseEmailSendV1(content: string, maxContentBytes: number): EmailSendV1 {
  if (utf8Length(content) > maxContentBytes) {
    throw new InputError('payload_too_large', 'XMTP message exceeds the configured size limit');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InputError('invalid_payload', 'XMTP message content must be valid JSON');
  }

  const value = requireRecord(parsed, 'invalid_payload');
  rejectUnknownKeys(value, ALLOWED_SEND_KEYS, 'invalid_payload');
  if (value.type !== EMAIL_SEND_V1) {
    throw new InputError('invalid_payload', `type must be ${EMAIL_SEND_V1}`);
  }

  const to = parseRecipientList(value.to, 'to', true);
  const cc = parseRecipientList(value.cc ?? [], 'cc', false);
  const bcc = parseRecipientList(value.bcc ?? [], 'bcc', false);
  if (to.length + cc.length + bcc.length > 50) {
    throw new InputError('too_many_recipients', 'Combined to/cc/bcc recipients must not exceed 50');
  }

  const subject = parseOptionalString(value.subject, 'subject', 2_048) ?? '';
  assertNoHeaderControls(subject, 'subject');
  const text = parseNullableBody(value.text, 'text');
  const html = parseNullableBody(value.html, 'html');
  if (utf8Length(text ?? '') + utf8Length(html ?? '') > maxContentBytes) {
    throw new InputError('payload_too_large', 'Combined email body exceeds the configured size limit');
  }

  const replyTo = parseOptionalString(value.replyTo, 'replyTo', 254);
  if (replyTo !== null) validateEmailAddress(replyTo, 'replyTo');

  return {
    type: EMAIL_SEND_V1,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    replyTo,
  };
}

export function makeEmailSendResult(input: {
  ok: boolean;
  providerMessageId?: string | null;
  error?: string | null;
}): EmailSendResultV1 {
  return {
    type: EMAIL_SEND_RESULT_V1,
    ok: input.ok,
    providerMessageId: input.providerMessageId ?? null,
    error: input.error ?? null,
  };
}

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL_PATTERN.test(value) && !/[\r\n\0]/.test(value);
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseRecipientList(input: unknown, name: string, required: boolean): string[] {
  if (!Array.isArray(input)) {
    throw new InputError('invalid_payload', `${name} must be an array`);
  }
  if ((required && input.length === 0) || input.length > 20) {
    throw new InputError('invalid_payload', `${name} must contain ${required ? '1-20' : '0-20'} addresses`);
  }

  return input.map((item) => {
    if (typeof item !== 'string') {
      throw new InputError('invalid_payload', `${name} entries must be strings`);
    }
    return validateEmailAddress(item, name);
  });
}

function validateEmailAddress(input: string, name: string): string {
  const value = input.trim();
  if (!isEmailAddress(value)) {
    throw new InputError('invalid_recipient', `${name} contains an invalid email address`);
  }
  return value;
}

function parseOptionalString(input: unknown, name: string, maxBytes: number): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new InputError('invalid_payload', `${name} must be a string or null`);
  }
  if (utf8Length(input) > maxBytes) {
    throw new InputError('payload_too_large', `${name} exceeds ${maxBytes} bytes`);
  }
  return input;
}

function parseNullableBody(input: unknown, name: string): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new InputError('invalid_payload', `${name} must be a string or null`);
  }
  return input;
}

function requireRecord(input: unknown, code: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError(code, 'Expected a JSON object');
  }
  return input as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, code: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new InputError(code, `Unknown field: ${unknown}`);
}

function requireBoundedString(
  input: unknown,
  name: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (typeof input !== 'string' || (!allowEmpty && input.trim().length === 0)) {
    throw new InputError('invalid_event', `${name} must be a non-empty string`);
  }
  if (utf8Length(input) > maxBytes) {
    throw new InputError('payload_too_large', `${name} exceeds ${maxBytes} bytes`);
  }
  if (/[\0]/.test(input)) throw new InputError('invalid_event', `${name} contains a NUL byte`);
  return input;
}

function assertNoHeaderControls(value: string, name: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new InputError('invalid_payload', `${name} contains forbidden control characters`);
  }
}
