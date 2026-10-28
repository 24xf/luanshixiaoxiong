// 防御工事：传送带建造机制 + 攻击顺序辅助
import { makeFort } from '../types.js';

// 每个英雄两个工事位：far(远位) / near(近位)。
// 建造优先级：① 近位被摧毁(hp<=0) → 原地重建近位；② 远位被摧毁 → 重建远位；
// ③ 两槽都存活 → 传送带（新入 near，原 near 推 far，原 far 丢弃）。
export function buildFort(player, proto) {
  const f = makeFort(proto);
  if (player.fortNear && player.fortNear.hp <= 0) {
    player.fortNear = f; // 重建被摧毁的近位
    return f;
  }
  if (player.fortFar && player.fortFar.hp <= 0) {
    player.fortFar = f; // 重建被摧毁的远位
    return f;
  }
  if (player.fortNear) player.fortFar = player.fortNear; // 两槽存活：传送带
  player.fortNear = f;
  return f;
}

// 攻击顺序：必须先打 far，再 near，两位全清才能打 hero。
// 返回下一个应受击的层：'far' | 'near' | 'hero' | null(已无该层)
export function nextFortLayer(player) {
  if (player.fortFar && player.fortFar.hp > 0) return 'far';
  if (player.fortNear && player.fortNear.hp > 0) return 'near';
  return 'hero';
}
