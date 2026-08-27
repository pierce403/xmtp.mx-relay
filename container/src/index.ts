import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { closeServer, createHttpServer, listen } from './server.js';
import { startupFailureDisposition } from './startup-policy.js';
import { XmtpSupervisor } from './supervisor.js';

const config = loadConfig();
const log = createLogger(config.logLevel).child({ processRole: 'supervisor' });
const supervisor = new XmtpSupervisor(config, log, {
  onProcessRestartRequired(error) {
    log.fatal({ error, alert: 'XMTP_RUNTIME_RESTART_REQUIRED' }, 'container.runtime_restart_required');
    void shutdown('runtime_failure', 1);
  },
});
const server = createHttpServer({
  supervisor,
  sharedSecret: config.containerSharedSecret,
  maxRequestBodyBytes: config.maxRequestBodyBytes,
  log,
});

let shutdownPromise: Promise<void> | null = null;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    log.info({ signal }, 'container.shutdown_started');
    const forcedExit = setTimeout(() => {
      log.fatal({ signal }, 'container.shutdown_timeout');
      process.exit(1);
    }, 14 * 60_000);
    forcedExit.unref();
    try {
      await supervisor.shutdown();
      await closeServer(server);
      clearTimeout(forcedExit);
      log.info({ signal }, 'container.shutdown_complete');
      process.exitCode = exitCode;
    } catch (error) {
      log.error({ error, signal }, 'container.shutdown_failed');
      process.exitCode = 1;
    }
  })();
  return shutdownPromise;
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

async function main(): Promise<void> {
  await listen(server, config.port);
  log.info({ port: config.port }, 'container.http_listening');
  try {
    await supervisor.start();
  } catch (error) {
    if (startupFailureDisposition(error) === 'hold_for_operator') {
      supervisor.markFatal(error);
      return;
    }
    // A transient startup/R2/network failure must terminate the process so the
    // Cloudflare watchdog can restart it. Keeping an HTTP-only fatal process
    // alive would strand the real-time XMTP stream indefinitely.
    log.fatal({ error, alert: 'XMTP_TRANSIENT_STARTUP_FAILURE' }, 'container.startup_restart_required');
    await shutdown('startup_failure', 1);
  }
}

void main();
