import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Logs go to stdout as JSON and rotation is left to Docker. Anything else means a bot in a
 * container quietly filling a volume nobody is watching.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    // The API key and server password are the two things most likely to end up in a log
    // line by accident, via a config object being logged wholesale.
    redact: {
      paths: [
        'apiKey',
        '*.apiKey',
        'clientQuery.apiKey',
        'config.clientQuery.apiKey',
        'serverPassword',
        '*.serverPassword',
        'adminToken',
        '*.adminToken',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

/**
 * Adapts pino to the narrow logging interface the contexts declare, so no domain or
 * application module has to depend on pino's type.
 */
export interface ScopedLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export function scopedLogger(logger: Logger, bindings: Record<string, unknown> = {}): ScopedLogger {
  const child = logger.child(bindings);
  return {
    debug: (message, details) => child.debug(details ?? {}, message),
    info: (message, details) => child.info(details ?? {}, message),
    warn: (message, details) => child.warn(details ?? {}, message),
    error: (message, details) => child.error(details ?? {}, message),
  };
}
