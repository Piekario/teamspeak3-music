import { z } from 'zod';

import { err, ok, type Result } from './shared-kernel/result.ts';

/**
 * Environment configuration, validated once at startup.
 *
 * A misconfigured bot should fail immediately and say which variable is wrong, rather than
 * starting and then failing obscurely the first time somebody types `!play`.
 */
/**
 * An optional string that treats "" as absent.
 *
 * Compose writes an empty value for an unset variable rather than omitting it, and an empty
 * string is not "no setting" to zod — so without this, `--cookies ""` would be passed to
 * yt-dlp and every lookup would fail on a cookies file that does not exist.
 */
const optionalText = () =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z.string().optional(),
  );

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
  YTDLP_POT_PROVIDER_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z.string().url().optional(),
  ),
  YTDLP_COOKIES_FILE: optionalText(),
  YTDLP_EXTRACTOR_ARGS: optionalText(),
  /**
   * Egress proxy for everything that talks to YouTube, e.g. `socks5://tunnel:1080`.
   *
   * Applied to yt-dlp and to ffmpeg's media fetch together, and deliberately as a single
   * setting: a googlevideo URL is bound to the IP that requested it, so the two must leave
   * by the same address or playback fails with 403 on a URL that looks perfectly valid.
   */
  YTDLP_PROXY: optionalText(),

  FFMPEG_BINARY: z.string().default('ffmpeg'),
  PACTL_BINARY: z.string().default('pactl'),

  /**
   * Which TeamSpeak transport to use.
   *
   * `clientquery` drives a headless GUI client per bot — one emulated container each, but
   * the path with the most hours on it. `gateway` speaks the protocol directly through
   * TSLib: every bot in one process, no emulation, no virtual sound card, identities
   * generated in code.
   */
  TS3_TRANSPORT: z.enum(['clientquery', 'gateway']).default('clientquery'),
  GATEWAY_URL: z.string().default('ws://ts3-gateway:8080/control'),
  GATEWAY_PCM_HOST: z.string().default('ts3-gateway'),
  GATEWAY_PCM_PORT: z.coerce.number().int().min(1).max(65535).default(8477),

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
