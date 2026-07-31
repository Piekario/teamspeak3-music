import { InstanceManager } from './contexts/instances/application/instance-manager.ts';
import { GatewayConnection } from './contexts/instances/infrastructure/gateway/gateway-connection.ts';
import { buildTransport } from './composition/create-transport.ts';
import { YtDlpResolver } from './contexts/playback/infrastructure/ytdlp-resolver.ts';
import { describeInstanceFileError, loadInstanceConfigs } from './composition/load-instances.ts';
import { loadConfig } from './config.ts';
import { createHttpServer } from './infrastructure/http/server.ts';
import { createLogger, scopedLogger } from './infrastructure/logging/logger.ts';
import { systemClock } from './shared-kernel/clock.ts';
import { EventBus } from './shared-kernel/event-bus.ts';

/**
 * Composition root: the single place anything is constructed and wired.
 *
 * Every other module takes its collaborators through its constructor, which is what keeps
 * the rest of the codebase free of imports that reach across layers and makes each piece
 * testable with a fake. If a dependency is not visible in this file, it does not exist.
 */
async function main(): Promise<void> {
  const configResult = loadConfig();
  if (!configResult.ok) {
    // No logger yet — and a config failure has to be readable regardless.
    console.error('Configuration is invalid:');
    for (const issue of configResult.error.issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  const config = configResult.value;

  const logger = createLogger(config.LOG_LEVEL);
  const scoped = scopedLogger(logger, { component: 'app' });

  const instanceConfigs = loadInstanceConfigs(config.INSTANCES_FILE);
  if (!instanceConfigs.ok) {
    scoped.error(describeInstanceFileError(instanceConfigs.error));
    process.exit(1);
  }

  // A throwing subscriber must never take down playback, so the bus reports rather than
  // propagates. This is the only place that policy is decided.
  const events = new EventBus((error, event) => {
    scoped.error('event handler threw', {
      eventType: event.type,
      instanceId: event.instanceId,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });

  const resolvers = [
    new YtDlpResolver({
      binary: config.YTDLP_BINARY,
      potProviderUrl: config.YTDLP_POT_PROVIDER_URL,
      cookiesFile: config.YTDLP_COOKIES_FILE,
      extractorArgs: config.YTDLP_EXTRACTOR_ARGS,
      proxy: config.YTDLP_PROXY,
    }),
  ];

  /**
   * Identities issued by the gateway are held in memory for now — a deliberate stop short of
   * persistence. A restart currently costs each bot its identity and therefore whatever
   * server groups an admin granted it, which is precisely what the instances table is for
   * once instance CRUD lands.
   */
  const identities = new Map<string, { key: string | null; offset: number }>();

  // The gateway holds every bot in one process, so one connection serves them all. The
  // ClientQuery transport instead opens a socket per instance, and needs none of this.
  const gateway =
    config.TS3_TRANSPORT === 'gateway'
      ? new GatewayConnection({
          url: config.GATEWAY_URL,
          logger: scopedLogger(logger, { component: 'gateway' }),
          // Bots live inside the gateway process: if it restarted they are gone, so every
          // instance has to be recreated rather than merely reconnected.
          onReady: async () => {
            for (const runtime of instances.all) runtime.start();
          },
        })
      : undefined;

  const instances = InstanceManager.withDependencies({
    clock: systemClock,
    events,
    resolvers,
    binaries: { ffmpeg: config.FFMPEG_BINARY, pactl: config.PACTL_BINARY },
    proxy: config.YTDLP_PROXY,
    webUrl: config.WEB_URL,
    logger: scopedLogger(logger, { component: 'instance' }),
    buildTransport: (instanceConfig, onReady) =>
      buildTransport(
        {
          appConfig: config,
          clock: systemClock,
          logger: scopedLogger(logger, { component: 'transport' }),
          gateway,
          storedIdentity: (instanceId) => identities.get(instanceId) ?? { key: null, offset: 0 },
          onIdentityIssued: (instanceId, key, offset, uid) => {
            identities.set(instanceId, { key, offset });
            scoped.info('gateway issued a bot identity', { instance: instanceId, uid });
          },
        },
        instanceConfig,
        onReady,
      ),
  });

  gateway?.connect();

  for (const instanceConfig of instanceConfigs.value) {
    const added = instances.add(instanceConfig);
    if (!added.ok) {
      scoped.error('duplicate instance id in configuration', { id: instanceConfig.id });
      process.exit(1);
    }
  }

  const server = await createHttpServer({
    host: config.HTTP_HOST,
    port: config.HTTP_PORT,
    adminToken: config.ADMIN_TOKEN,
    instances,
    events,
    clock: systemClock,
    logger,
    scoped: scopedLogger(logger, { component: 'http' }),
  });

  const address = await server.listen();
  scoped.info('listening', { address, instances: instances.ids });

  instances.startAll();

  /**
   * Shutdown order matters: stop accepting requests, then stop the bots. Doing it the other
   * way round leaves a window where the panel can issue commands to a half-stopped bot.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    scoped.info('shutting down', { signal });
    try {
      await server.close();
      await instances.stopAll();
    } catch (error) {
      scoped.error('shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('Fatal startup error:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
