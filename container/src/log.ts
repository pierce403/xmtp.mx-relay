import pino from 'pino';

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    base: {
      service: 'xmtp-mx-relay-container',
      deploymentId: process.env.CLOUDFLARE_DEPLOYMENT_ID ?? null,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  });
}
