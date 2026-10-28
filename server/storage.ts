// 持久化层：每回合把房间状态序列化保存，支撑"断线重连不丢数据"与"进程重启可恢复"。
// 双实现：Redis（生产）/ 内存（开发/无 Redis 时自动降级）。通过 Storage 接口互换。

export interface Storage {
  save(roomId: string, data: string): Promise<void>;
  load(roomId: string): Promise<string | null>;
  del(roomId: string): Promise<void>;
  keys(prefix: string): Promise<string[]>; // 启动恢复：扫描 room:* 键
  quit?(): Promise<void>;
}

// ---- 内存实现（总是可用，进程内）----
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  async save(roomId: string, data: string) { this.map.set(roomId, data); }
  async load(roomId: string) { return this.map.get(roomId) ?? null; }
  async del(roomId: string) { this.map.delete(roomId); }
  async keys(prefix: string) { return [...this.map.keys()].filter((k) => k.startsWith(prefix)); }
}

// ---- Redis 实现（可选，连接失败自动降级为内存）----
class RedisStorage implements Storage {
  private client: any = null;
  private fallback = new MemoryStorage();
  private usable = false;

  constructor(private url: string) {}

  async init(): Promise<void> {
    try {
      const { createClient } = await import('redis');
      this.client = createClient({ url: this.url });
      this.client.on('error', () => { /* 静默，走降级 */ });
      await this.client.connect();
      this.usable = true;
      console.log('[storage] Redis 已连接，持久化走 Redis');
    } catch {
      this.usable = false;
      console.log('[storage] Redis 不可用，降级为内存持久化（重连数据仅在本进程有效）');
    }
  }

  async save(roomId: string, data: string) {
    if (this.usable) {
      try { await this.client.set(roomId, data); return; } catch { /* 降级 */ }
    }
    await this.fallback.save(roomId, data);
  }
  async load(roomId: string): Promise<string | null> {
    if (this.usable) {
      try { const v = await this.client.get(roomId); if (v) return v; } catch { /* 降级 */ }
    }
    return this.fallback.load(roomId);
  }
  async del(roomId: string) {
    if (this.usable) { try { await this.client.del(roomId); } catch { /* 忽略 */ } }
    await this.fallback.del(roomId);
  }
  async keys(prefix: string) {
    if (this.usable) {
      try { const ks = await this.client.keys(`${prefix}*`); if (ks.length) return ks; } catch { /* 降级 */ }
    }
    return this.fallback.keys(prefix);
  }
  async quit(): Promise<void> {
    if (this.usable && this.client) { try { await this.client.quit(); } catch { /* 忽略 */ } }
  }
}

export async function createStorage(): Promise<Storage> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[storage] 未设置 REDIS_URL，使用内存持久化');
    return new MemoryStorage();
  }
  const r = new RedisStorage(url);
  await r.init();
  return r;
}
