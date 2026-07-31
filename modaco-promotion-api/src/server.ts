import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './shared/logger';

async function main(): Promise<void> {
  const { app, cache } = await buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info('api listening', { port: env.PORT });
  });
  const shutdown = async (): Promise<void> => {
    await cache.quit();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error) => {
  logger.error('startup failed', { error: String(error) });
  process.exit(1);
});
