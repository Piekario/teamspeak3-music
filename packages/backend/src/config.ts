import { z } from 'zod';

import { err, ok, type Result } from './shared-kernel/result.ts';

/**
 * Environment configuration, validated once at startup.
 *
 * A misconfigured bot should fail immediately and say which variable is wrong, rather than
 * starting and then failing obscurely the first time somebody types `!play`.
 */
const environmentSchema = z.object({
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HTTP_HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Guards every mutating route and the WebSocket handshake. There is no default: a bot
  // that can be driven by anyone who can reach the port is not a useful default.
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters'),

  DATABASE_PATH: z.string().default('./data/tsmusic.db'),
  INSTANCES_FILE: z.string().default('./instances.json'),

  YTDLP_BINARY: z.string().default('yt-dlp'),
  YTDLP_AUTO_UPDATE: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() === 'true'),
  YTDLP_POT_PROVIDER_URL: z.string().url().optional(),
  YTDLP_COOKIES_FILE: z.string().optional(),
  YTDLP_EXTRACTOR_ARGS: z.string().optional(),

  FFMPEG_BINARY: z.string().default('ffmpeg'),
  PACTL_BINARY: z.string().default('pactl'),

  /** Shown in chat when a queue listing is too long to print. */
  WEB_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export type ConfigError = { readonly kind: 'config/invalid'; readonly issues: readonly string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Result<AppConfig, ConfigError> {
  const parsed = environmentSchema.safeParse(env);
  if (parsed.success) return ok(parsed.data);

  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  return err({ kind: 'config/invalid', issues });
}
