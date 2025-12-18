import formData from 'form-data';
import Mailgun from 'mailgun.js';
import type { MailgunMessageData } from 'mailgun.js';

export type MailgunSendEmailInput = {
  apiKey: string;
  domain: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  replyTo: string | null;
};

export async function sendEmailViaMailgun(input: MailgunSendEmailInput): Promise<{ id: string | null }> {
  const mailgun = new Mailgun(formData);
  const mg = mailgun.client({ username: 'api', key: input.apiKey });

  const data: MailgunMessageData = {
    from: input.from,
    to: input.to,
    cc: input.cc.length > 0 ? input.cc : undefined,
    bcc: input.bcc.length > 0 ? input.bcc : undefined,
    subject: input.subject || '(no subject)',
    // Mailgun types require at least one of: text/html/message/template.
    text: input.text ?? '',
  };

  if (input.html !== null) data.html = input.html;
  if (input.replyTo) data['h:Reply-To'] = input.replyTo;

  try {
    const response = (await mg.messages.create(input.domain, data)) as unknown as { id?: string };
    return { id: response.id ?? null };
  } catch (error) {
    const status = (error as { status?: number | string; statusCode?: number | string } | null)?.statusCode
      ?? (error as { status?: number | string } | null)?.status;
    const baseMessage = error instanceof Error ? error.message : String(error);

    if (status === 401 || status === 403) {
      throw new Error(
        `Mailgun unauthorized (status ${status}). Check MAILGUN_API_KEY, MAILGUN_DOMAIN, region, and sending permissions.`,
      );
    }

    throw new Error(
      `Mailgun send failed${status ? ` (status ${status})` : ''}: ${baseMessage}`,
    );
  }
}
