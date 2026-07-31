import express, { type Express } from 'express';
import { createCache, type CacheService } from './cache';
import { buildStorage, type Storage } from './ingest/storage';
import { productRoutes } from './modules/products/product.routes';
import { promotionRoutes } from './modules/promotions/promotion.routes';
import { ingestRoutes } from './ingest/ingest.routes';
import { errorHandler, notFoundHandler } from './shared/middleware';

export interface AppDeps {
  cache: CacheService;
  storage: Storage;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/products', productRoutes(deps));
  app.use('/promotions', promotionRoutes(deps));
  app.use(ingestRoutes(deps));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export async function buildApp(): Promise<{ app: Express; cache: CacheService }> {
  const cache = await createCache();
  const storage = buildStorage();
  return { app: createApp({ cache, storage }), cache };
}
