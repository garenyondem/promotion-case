import { createClient } from 'redis';
import type { CacheProvider } from './provider';

export class RedisCache implements CacheProvider {
  private readonly client: ReturnType<typeof createClient>;

  constructor(url: string) {
    this.client = createClient({ url });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, { EX: ttlSeconds });
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async getNumber(key: string): Promise<number> {
    const value = await this.client.get(key);
    return value ? Number(value) : 0;
  }

  async quit(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}
