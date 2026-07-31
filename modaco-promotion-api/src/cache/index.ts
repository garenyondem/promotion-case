import { env } from '../config/env';
import { logger } from '../shared/logger';
import { MemoryCache } from './memory-cache';
import type { CacheProvider } from './provider';
import { RedisCache } from './redis-cache';

export class CacheService {
  constructor(
    private readonly provider: CacheProvider,
    private readonly ttlProduct: number,
    private readonly ttlListing: number,
  ) {}

  private async generation(): Promise<number> {
    try {
      return await this.provider.getNumber('cache:generation');
    } catch (error) {
      logger.warn('cache generation read failed', { error: String(error) });
      return 0;
    }
  }

  async bumpGeneration(): Promise<void> {
    try {
      await this.provider.incr('cache:generation');
    } catch (error) {
      logger.warn('cache generation bump failed', { error: String(error) });
    }
  }

  async getProduct(id: string): Promise<unknown> {
    try {
      const value = await this.provider.get(`product:${await this.generation()}:${id}`);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.warn('cache get product failed', { id, error: String(error) });
      return null;
    }
  }

  async setProduct(id: string, dto: unknown): Promise<void> {
    try {
      await this.provider.set(
        `product:${await this.generation()}:${id}`,
        JSON.stringify(dto),
        this.ttlProduct,
      );
    } catch (error) {
      logger.warn('cache set product failed', { id, error: String(error) });
    }
  }

  async getListing(key: string): Promise<unknown> {
    try {
      const value = await this.provider.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.warn('cache get listing failed', { key, error: String(error) });
      return null;
    }
  }

  async setListing(key: string, payload: unknown): Promise<void> {
    try {
      await this.provider.set(key, JSON.stringify(payload), this.ttlListing);
    } catch (error) {
      logger.warn('cache set listing failed', { key, error: String(error) });
    }
  }

  async listingKey(
    category: string | undefined,
    sort: string,
    page: number,
    limit: number,
  ): Promise<string> {
    const scope = category === undefined ? 'all' : `cat:${category}`;
    return `products:${await this.generation()}:${scope}::${sort}:${page}:${limit}`;
  }

  async quit(): Promise<void> {
    try {
      await this.provider.quit();
    } catch (error) {
      logger.warn('cache quit failed', { error: String(error) });
    }
  }
}

export async function createCache(): Promise<CacheService> {
  if (env.CACHE_DRIVER === 'memory') {
    return new CacheService(new MemoryCache(), env.CACHE_TTL_PRODUCT, env.CACHE_TTL_LISTING);
  }
  const redis = new RedisCache(env.REDIS_URL);
  try {
    await redis.connect();
    return new CacheService(redis, env.CACHE_TTL_PRODUCT, env.CACHE_TTL_LISTING);
  } catch (error) {
    logger.warn('redis unavailable, falling back to memory cache', { error: String(error) });
    return new CacheService(new MemoryCache(), env.CACHE_TTL_PRODUCT, env.CACHE_TTL_LISTING);
  }
}
