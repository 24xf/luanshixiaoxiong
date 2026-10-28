// 缓存抽象：Redis(生产，REDIS_URL) / 内存 Map(本地或 Redis 不可用时降级)。
// 用途：会话 token 与热档案/战绩。与现有“无 REDIS_URL 降级 LocalBus”思路一致。
import { log } from '../log.js';

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  del(key: string): Promise<void>;
}

class MemCache implements Cache {
  private m = new Map<string, { v: string; exp: number }>();
  async get(k: string): Promise<string | null> {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) { this.m.delete(k); return null; }
    return e.v;
  }
  async set(k: string, v: string, ttl = 0): Promise<void> { this.m.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 }); }
  async del(k: string): Promise<void> { this.m.delete(k); }
}

class RedisCache implements Cache {
  constructor(private c: any) {}
  async get(k: string): Promise<string | null> { const v = await this.c.get(k); return v == null ? null : String(v); }
  async set(k: string, v: string, ttl = 0): Promise<void> { if (ttl) await this.c.set(k, v, 'EX', ttl); else await this.c.set(k, v); }
  async del(k: string): Promise<void> { await this.c.del(k); }
}

let cache: Cache | null = null;

export async function initCache(): Promise<Cache> {
  if (cache) return cache;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const { createClient } = await import('redis');
      const c: any = createClient({ url });
      await c.connect();
      cache = new RedisCache(c);
      log.info('cache', { type: 'redis' });
      return cache;
    } catch (e) {
      log.warn('cache_redis_fail', { err: (e as Error).message, note: '降级为内存缓存' });
    }
  }
  cache = new MemCache();
  log.info('cache', { type: 'memory' });
  return cache;
}

export function getCache(): Cache { if (!cache) throw new Error('缓存未初始化'); return cache; }
