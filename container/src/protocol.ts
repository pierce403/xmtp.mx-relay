import { z } from 'zod';

const inboxIdSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const boundedText = (max: number) => z.string().max(max);

export const emailInboundV1Schema = z
  .object({
    type: z.literal('email.inbound.v1'),
    to: boundedText(2_048),
    from: boundedText(2_048),
    subject: boundedText(16_384),
    text: boundedText(256 * 1024).nullable(),
    html: boundedText(256 * 1024).nullable(),
    messageId: boundedText(4_096).nullable(),
    receivedAt: z.string().datetime(),
  })
  .strict();

export const emailSendResultV1Schema = z
  .object({
    type: z.literal('email.send.result.v1'),
    ok: z.boolean(),
    providerMessageId: boundedText(4_096).nullable(),
    error: boundedText(16_384).nullable(),
  })
  .strict();

export const deliveryRequestSchema = z
  .object({
    jobId: z.string().min(1).max(256),
    kind: z.enum(['email.inbound.v1', 'email.send.result.v1']),
    conversationId: z.string().min(1).max(512).optional(),
    recipientInboxId: inboxIdSchema.optional(),
    // Compatibility alias for the inbox that originated email.send.v1.
    senderInboxId: inboxIdSchema.optional(),
    payload: z.union([emailInboundV1Schema, emailSendResultV1Schema]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== value.payload.type) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'kind must match payload.type' });
    }
    if (
      value.kind === 'email.send.result.v1' &&
      !value.conversationId &&
      !value.recipientInboxId &&
      !value.senderInboxId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'email.send.result.v1 requires conversationId or recipientInboxId',
      });
    }
  });

export type DeliveryRequest = z.infer<typeof deliveryRequestSchema>;

export type EdgeXmtpEvent = {
  messageId: string;
  senderInboxId: string;
  conversationId: string;
  content: string;
  receivedAt: string;
};

export type ParentToChildMessage =
  | { type: 'deliver'; requestId: string; request: DeliveryRequest }
  | { type: 'shutdown'; reason: string };

export type ChildToParentMessage =
  | {
      type: 'ready';
      currentInboxId: string;
      pinnedInboxId: string;
      installationId: string;
      replayAfter: string;
    }
  | { type: 'delivery_result'; requestId: string; ok: true; xmtpMessageId: string }
  | { type: 'delivery_result'; requestId: string; ok: false; error: string }
  | { type: 'status'; event: string; at: string; detail?: string }
  | { type: 'fatal'; error: string; recoveryRequired: boolean };
