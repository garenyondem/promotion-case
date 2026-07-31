import type { CacheProvider } from './provider';

interface Entry {
  value: string;
  expiresAt: number;
}

export class MemoryCache implements CacheProvider {
  private readonly store = new Map<string, Entry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string): Promise<number> {
    const next = (await this.getNumber(key)) + 1;
    this.store.set(key, { value: String(next), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    return next;
  }

  async getNumber(key: string): Promise<number> {
    const value = await this.get(key);
    return value ? Number(value) : 0;
  }

  async quit(): Promise<void> {
    this.store.clear();
  }
}
