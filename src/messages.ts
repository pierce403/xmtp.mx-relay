import { z } from 'zod';

export const emailSendV1Schema = z
  .object({
    type: z.literal('email.send.v1'),
    to: z.array(z.string().email()).min(1).max(20),
    cc: z.array(z.string().email()).max(20).optional().default([]),
    bcc: z.array(z.string().email()).max(20).optional().default([]),
    subject: z.string().optional().default(''),
    text: z.string().nullable().optional().default(null),
    html: z.string().nullable().optional().default(null),
    replyTo: z.string().nullable().optional().default(null),
  })
  .strict();

export type EmailSendV1 = z.infer<typeof emailSendV1Schema>;

export type EmailSendResultV1 = {
  type: 'email.send.result.v1';
  ok: boolean;
  mailgunId: string | null;
  error: string | null;
};

export function makeEmailSendResultV1(result: {
  ok: boolean;
  mailgunId?: string | null;
  error?: string | null;
}): EmailSendResultV1 {
  return {
    type: 'email.send.result.v1',
    ok: result.ok,
    mailgunId: result.mailgunId ?? null,
    error: result.error ?? null,
  };
}

