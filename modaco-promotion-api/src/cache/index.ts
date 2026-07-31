import { createClient } from 'redis';
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
    return this.provider.getNumber('cache:generation');
  }

  async bumpGeneration(): Promise<void> {
    await this.provider.incr('cache:generation');
  }

  async getProduct(id: string): Promise<unknown> {
    const value = await this.provider.get(`product:${await this.generation()}:${id}`);
    return value ? JSON.parse(value) : null;
  }

  async setProduct(id: string, dto: unknown): Promise<void> {
    await this.provider.set(`product:${await this.generation()}:${id}`, JSON.stringify(dto), this.ttlProduct);
  }

  async getListing(key: string): Promise<unknown> {
    const value = await this.provider.get(key);
    return value ? JSON.parse(value) : null;
  }

  async setListing(key: string, payload: unknown): Promise<void> {
    await this.provider.set(key, JSON.stringify(payload), this.ttlListing);
  }

  async listingKey(category: string | undefined, sort: string, page: number, limit: number): Promise<string> {
    return `products:${await this.generation()}:${category ?? '*'}::${sort}:${page}:${limit}`;
  }

  async quit(): Promise<void> {
    await this.provider.quit();
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
