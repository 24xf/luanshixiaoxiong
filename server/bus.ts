// 消息总线 + 房间归属注册表（横向扩展核心）。
// 双实现：
//  - LocalBus：进程内 EventEmitter + Map，供单实例/测试（无需 Redis）。
//  - RedisBus：Redis pub/sub 做跨实例消息转发，SET NX/EX 做房间归属（带 TTL 心跳）。
// 上层（index.ts）不关心实现了谁，只调 publish/subscribe/claimOwner/getOwner/releaseOwner。
import { EventEmitter } from 'events';
import { getSharedRedis, newRedisConn } from './redis-shared.js';
import { log } from './log.js';

export interface Bus {
  publish(channel: string, msg: unknown): void;
  subscribe(channel: string, handler: (msg: any) => void): void;
  // 房间归属：本实例 claim 成功后成为权威；TTL 心跳防脑裂
  claimOwner(roomId: string, instanceId: string, ttlMs: number): Promise<boolean>;
  getOwner(roomId: string): Promise<string | null>;
  releaseOwner(roomId: string): Promise<void>;
  readonly distributed: boolean; // 是否跨实例（Redis）
  close(): Promise<void>;
}

// ---------------- 进程内实现 ----------------
export class LocalBus implements Bus {
  readonly distributed = false;
  private ee = new EventEmitter();
  private owners = new Map<string, { owner: string; exp: number }>();
  publish(channel: string, msg: unknown) { this.ee.emit(channel, msg); }
  subscribe(channel: string, handler: (msg: any) => void) { this.ee.on(channel, handler); }
  async claimOwner(roomId: string, instanceId: string, ttlMs: number): Promise<boolean> {
    const cur = this.owners.get(roomId);
    const now = Date.now();
    if (!cur || cur.exp < now || cur.owner === instanceId) {
      this.owners.set(roomId, { owner: instanceId, exp: now + ttlMs });
      return true;
    }
    return false;
  }
  async getOwner(roomId: string): Promise<string | null> {
    const cur = this.owners.get(roomId);
    if (cur && cur.exp >= Date.now()) return cur.owner;
    this.owners.delete(roomId);
    return null;
  }
  async releaseOwner(roomId: string): Promise<void> { this.owners.delete(roomId); }
  async close() { this.ee.removeAllListeners(); }
}

// ---------------- Redis 实现 ----------------
export class RedisBus implements Bus {
  readonly distributed = true;
  private pub: any;
  private sub: any;
  private handlers = new Map<string, ((msg: any) => void)[]>();
  constructor(pub: any, sub: any) {
    this.pub = pub; this.sub = sub;
    this.sub.on('message', (ch: string, raw: string) => {
      let msg: any; try { msg = JSON.parse(raw); } catch { msg = raw; }
      const hs = this.handlers.get(ch);
      if (hs) for (const h of hs) h(msg);
    });
  }
  publish(channel: string, msg: unknown) {
    // #12：底层投递失败必须可见（原 catch{/*忽略*/} 静默吞掉意图丢失），便于排查横向扩展消息丢失。
    try { this.pub.publish(channel, JSON.stringify(msg)); }
    catch (e) { log.error('bus_publish_fail', { channel, err: (e as Error).message }); }
  }
  subscribe(channel: string, handler: (msg: any) => void) {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, []);
      // #12：订阅失败记日志，不再静默吞掉
      this.sub.subscribe(channel).catch((e: unknown) => log.warn('bus_subscribe_fail', { channel, err: (e as Error).message }));
    }
    this.handlers.get(channel)!.push(handler);
  }
  private key(roomId: string) { return `roomowner:${roomId}`; }
  async claimOwner(roomId: string, instanceId: string, ttlMs: number): Promise<boolean> {
    const k = this.key(roomId);
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    const cur = await this.pub.get(k);
    if (cur === null) {
      const r = await this.pub.set(k, instanceId, { NX: true, EX: ttlSec });
      return r === 'OK';
    }
    if (cur === instanceId) {
      await this.pub.set(k, instanceId, { EX: ttlSec }); // 刷新 TTL
      return true;
    }
    return false;
  }
  async getOwner(roomId: string): Promise<string | null> {
    const v = await this.pub.get(this.key(roomId));
    return v ?? null;
  }
  async releaseOwner(roomId: string): Promise<void> {
    await this.pub.del(this.key(roomId)).catch(() => {});
  }
  async close() { try { await this.pub.quit(); } catch {} try { await this.sub.quit(); } catch {} }
}

let busInstance: Bus | null = null;
let busSettled = false;

export async function getBus(): Promise<Bus> {
  if (busSettled) return busInstance!;
  busSettled = true;
  const redis = await getSharedRedis();
  const wantedDistributed = !!process.env.REDIS_URL; // 操作者是否"意图"横向扩展
  if (redis && wantedDistributed) {
    const pub = await newRedisConn();
    const sub = await newRedisConn();
    if (pub && sub) { busInstance = new RedisBus(pub, sub); console.log('[bus] Redis 总线已启用（跨实例转发就绪）'); return busInstance; }
  }
  busInstance = new LocalBus();
  if (wantedDistributed) {
    // #12：REDIS_URL 已配但 Redis 不可用 → 静默降级为单实例是危险误配置（多实例部署会脑裂/丢意图）。
    // 改为显式高声告警，提醒操作者先确认 Redis 可达，再上多实例。
    log.warn('bus_degraded_single_instance', { note: 'REDIS_URL 已配置但 Redis 不可用，已降级为单实例；多实例部署请先确保 Redis 可达，否则存在脑裂/意图丢失风险' });
  } else {
    console.log('[bus] 进程内总线（单实例；配置 REDIS_URL 后自动启用跨实例）');
  }
  return busInstance;
}
