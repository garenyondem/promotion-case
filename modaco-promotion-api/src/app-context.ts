import type { CacheService } from './cache';
import type { Storage } from './ingest/storage';

export interface AppContext {
  cache: CacheService;
  storage: Storage;
}
