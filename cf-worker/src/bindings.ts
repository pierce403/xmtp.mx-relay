import type { XmtpDeliveryQueueMessage, EmailDeliveryQueueMessage } from './protocol';

export interface RelayEnv {
  RELAY_DB: D1Database;
  XMTP_STATE_BUCKET: R2Bucket;
  XMTP_DELIVERY_QUEUE: Queue<XmtpDeliveryQueueMessage>;
  EMAIL_DELIVERY_QUEUE: Queue<EmailDeliveryQueueMessage>;
  EMAIL: SendEmail;
  XMTP_RELAY: DurableObjectNamespace;

  CONTAINER_SHARED_SECRET: string;
  RELAY_ADMIN_TOKEN: string;
  RECOVERY_ADMIN_TOKEN: string;
  XMTP_BOT_KEY: string;
  XMTP_SNAPSHOT_SIGNING_KEY: string;

  INBOUND_EMAIL_TO: string;
  EMAIL_FROM: string;
  XMTP_ALLOWED_SENDERS?: string;
  XMTP_ENV?: string;
  XMTP_DEAN_ADDRESS: string;
  XMTP_EXPECTED_INBOX_ID: string;
  XMTP_EXPECTED_INSTALLATION_ID?: string;
  ETH_RPC_URL?: string;
  LOG_LEVEL?: string;

  CONTAINER_INSTANCE_NAME?: string;
  XMTP_R2_PREFIX?: string;
  XMTP_BACKUP_INTERVAL_SECONDS?: string;
  XMTP_BACKUP_MAX_STALENESS_SECONDS?: string;
  XMTP_FREE_SPACE_MARGIN_BYTES?: string;
  MAX_INBOUND_EMAIL_BYTES?: string;
  MAX_RELAY_BODY_BYTES?: string;
  MAX_INTERNAL_REQUEST_BYTES?: string;
  MAX_XMTP_BACKUP_BYTES?: string;
  MAX_XMTP_BACKUP_PART_BYTES?: string;
  QUEUE_MAX_RETRIES?: string;
  QUEUE_REPLAY_STALE_SECONDS?: string;
  QUEUE_ABANDONED_SECONDS?: string;
  QUEUE_ORPHANED_HANDOFF_SECONDS?: string;
  RECOVERY_DRILL_ENABLED?: string;
  RECOVERY_IMPORT_ENABLED?: string;
  XMTP_ALLOW_NEW_INSTALLATION?: string;
  XMTP_BOOTSTRAP_CONFIRM?: string;
}

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}
