// 共享 Redis 客户端（单例）。存储、总线、socket.io 适配器复用同一连接的不同 dup。
// 无 REDIS_URL 或连接失败时返回 null —— 此时系统降级为单实例模式（横向扩展不可用，但功能正常）。
import { createClient, type RedisClientType } from 'redis';

let client: RedisClientType | null = null;
let settled = false;

export async function getSharedRedis(): Promise<RedisClientType | null> {
  if (settled) return client;
  settled = true;
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[redis] 未设置 REDIS_URL → 单实例模式（横向扩展/跨实例恢复不可用，崩溃恢复仅限本进程内存存储）');
    return null;
  }
  try {
    const c = createClient({ url });
    c.on('error', () => { /* 静默，降级 */ });
    await c.connect();
    client = c as unknown as RedisClientType;
    console.log('[redis] 共享连接已建立（存储 + 总线 + 适配器）');
    return client;
  } catch (e) {
    console.log('[redis] 连接失败，降级为单实例模式:', (e as Error).message);
    return null;
  }
}

// 供 pub/sub / 适配器使用独立连接（redis 要求订阅客户端独占）。
// 注意：duplicate() 出的客户端处于「未连接」状态，必须显式 connect() 后才能用——
// 否则 socket.io redis-adapter 首次 broadcast 会抛 ClientClosedError 并把整个进程带崩（横向扩展致命 bug）。
export async function newRedisConn(): Promise<RedisClientType | null> {
  const c = await getSharedRedis();
  if (!c) return null;
  try { const d = (c as any).duplicate() as RedisClientType; await d.connect(); return d; } catch { return null; }
}
