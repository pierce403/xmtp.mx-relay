#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('node:crypto');

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value.trim();
}

async function main() {
  const url = process.env.URL?.trim() || 'http://localhost:3000/webhooks/mailgun/inbound';
  const signingKey = requireEnv('MAILGUN_WEBHOOK_SIGNING_KEY');

  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = crypto.randomBytes(16).toString('hex');
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(`${timestamp}${token}`)
    .digest('hex');

  const sender = process.env.SENDER?.trim() || 'Someone <someone@example.com>';
  const recipient = process.env.RECIPIENT?.trim() || (process.env.INBOUND_EMAIL_TO?.trim() || 'deanpierce.eth@xmtp.mx');
  const subject = process.env.SUBJECT?.trim() || 'Hello from fake-mailgun-inbound.js';
  const bodyPlain = process.env.BODY_PLAIN?.trim() || 'This is a test inbound email payload.';

  const messageId = process.env.MESSAGE_ID?.trim() || `<fake-${token}@local>`;

  const params = new URLSearchParams();
  params.set('timestamp', timestamp);
  params.set('token', token);
  params.set('signature', signature);
  params.set('sender', sender);
  params.set('recipient', recipient);
  params.set('subject', subject);
  params.set('body-plain', bodyPlain);
  params.set('Message-Id', messageId);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const text = await res.text().catch(() => '');
  console.log(`POST ${url} -> ${res.status}`);
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

