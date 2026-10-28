// 英雄策略共享工具（无循环依赖）
// 选敌 / 工事统计等跨英雄通用逻辑集中此处，供各策略类调用。

export function aliveEnemies(state, pid) {
  return state.players.filter((p) => !p.dead && p.id !== pid);
}

// 选最弱敌方（英雄血量为主、工事血量折算），供 AI/箭塔自动攻击等使用
export function weakestEnemy(state, pid) {
  let best = null, bestScore = Infinity;
  for (const p of aliveEnemies(state, pid)) {
    const fortHp = (p.fortFar ? p.fortFar.hp : 0) + (p.fortNear ? p.fortNear.hp : 0);
    const score = p.hp + fortHp * 0.5;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// 统计某英雄持有的指定名称工事数量（远/近位，仅 hp>0 计入）
export function countFort(p, name) {
  let n = 0;
  if (p.fortFar && p.fortFar.name === name && p.fortFar.hp > 0) n++;
  if (p.fortNear && p.fortNear.name === name && p.fortNear.hp > 0) n++;
  return n;
}

// 取某英雄持有的指定名称工事（近位优先），无则 null
export function fortWithName(p, name) {
  if (p.fortNear && p.fortNear.name === name) return p.fortNear;
  if (p.fortFar && p.fortFar.name === name) return p.fortFar;
  return null;
}
