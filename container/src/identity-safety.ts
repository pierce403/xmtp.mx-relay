import { RecoveryRequiredError } from './snapshot.js';

/**
 * Enforces the on-disk identity pair before Client.create can open or create a
 * database. Only the explicit bootstrap state may have neither file.
 */
export function assertIdentityStoragePreconditions(args: {
  databaseExists: boolean;
  pinnedInboxId: string | null;
  expectedInboxId: string | null;
  allowNewInstallation: boolean;
  databasePath: string;
}): void {
  if (args.databaseExists && !args.pinnedInboxId) {
    throw new RecoveryRequiredError(
      'XMTP database exists but xmtp-inbox-id.txt is absent; refusing to construct Client or synthesize a replacement pin',
    );
  }
  if (!args.databaseExists && args.pinnedInboxId) {
    throw new RecoveryRequiredError(
      `xmtp-inbox-id.txt exists but database ${args.databasePath} is absent; refusing partial recovery`,
    );
  }
  if (
    args.pinnedInboxId &&
    args.expectedInboxId &&
    args.pinnedInboxId !== args.expectedInboxId
  ) {
    throw new RecoveryRequiredError(
      `pinned inbox ${args.pinnedInboxId} does not match XMTP_EXPECTED_INBOX_ID ${args.expectedInboxId}`,
    );
  }
  if (!args.databaseExists && !args.allowNewInstallation) {
    throw new RecoveryRequiredError(
      `expected restored database ${args.databasePath} is absent; refusing to construct Client or register an installation`,
    );
  }
}
