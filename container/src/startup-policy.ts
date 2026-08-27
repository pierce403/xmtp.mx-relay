import { RecoveryRequiredError } from './snapshot.js';

export type StartupFailureDisposition = 'hold_for_operator' | 'restart_process';

export function startupFailureDisposition(error: unknown): StartupFailureDisposition {
  if (error instanceof RecoveryRequiredError) return 'hold_for_operator';
  if (
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'recovery_required'
  ) return 'hold_for_operator';
  return 'restart_process';
}
