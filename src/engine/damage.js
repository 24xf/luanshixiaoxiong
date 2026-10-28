// 伤害结算管线（反射/溢出/吸血/死亡）
// 通用攻击流程：far 工事 -> near 工事 -> hero 本体
// 溢出规则：打 far 不溢出；打 near 溢出到 hero 减半 floor；打 hero 全额。

// 本地实现，避免与 effects.js 形成循环依赖
function hasStatusLocal(p, type) {
  return !!(p.statuses && p.statuses.find((s) => s.type === type));
}

// 车道挡伤管线（农夫等）：lanes = [{far, near}, ...]
// 规则（B3 修复后）：伤害按 lanes 顺序"逐路"吸收——每一路先打远位(稻草人)、再打近位(粮食)；
// 近位溢出时减半 floor(溢出/2) 后流向下一路。只有"所有路"的 far 与 near 都被清空，
// 剩余伤害才直击本体。这样农夫的 3 路防御真正生效（此前每个分支都 break，永远只处理 lanes[0]）。
// 注：与旧注释"任意一路清空即直击本体"相悖——旧语义会让 lanes[1..] 沦为摆设，已废弃。
function applyDamageLanes(state, targetId, amount, opts) {
  const t = getHero(state, targetId);
  if (!t || t.dead || amount <= 0) return;
  let remaining = amount;
  for (const lane of (t.lanes || [])) {
    if (remaining <= 0) break;
    // 远位（稻草人）：吸收伤害，溢出继续向后/本体传导
    if (lane.far && lane.far.hp > 0) {
      if (remaining >= lane.far.hp) { remaining -= lane.far.hp; lane.far.hp = 0; }
      else { lane.far.hp -= remaining; remaining = 0; }
    }
    // 近位（粮食）：吸收伤害，溢出到下一层（下一 lane 或本体）减半 floor(溢出/2)
    if (remaining > 0 && lane.near && lane.near.hp > 0) {
      if (remaining >= lane.near.hp) {
        const overflow = Math.floor((remaining - lane.near.hp) / 2);
        lane.near.hp = 0;
        remaining = overflow;
      } else {
        lane.near.hp -= remaining;
        remaining = 0;
      }
    }
    // 本路仍有存活层（远位/近位未清空）→ remaining 必为 0，自然停在当前路继续扛伤；
    // 本路已清空 → remaining 带走溢出流向下一 lane；循环结束仍剩余 → 直击本体。
  }
  if (remaining > 0) hitHero(state, targetId, remaining, opts);
}

function getHero(state, id) {
  return state.players[id];
}

// 对 hero 本体的伤害落地（含死亡判定 + 吸血回血）
function hitHero(state, targetId, amount, opts) {
  const t = getHero(state, targetId);
  if (!t || t.dead) return;
  t.hp -= amount;
  if (opts && opts.lifesteal && opts.sourceId != null) {
    const src = getHero(state, opts.sourceId);
    if (src && !src.dead) src.hp = Math.min(src.maxHp, src.hp + opts.lifesteal);
  }
  if (t.hp <= 0) {
    t.hp = 0;
    t.dead = true;
  }
}

// 仅对工事造成伤害（拆迁大队用），不溢出到 hero
export function applyFortDamage(state, targetId, amount) {
  const t = getHero(state, targetId);
  if (!t || t.dead) return;
  let remaining = amount;
  for (const layer of ['fortFar', 'fortNear']) {
    if (remaining <= 0) break;
    const f = t[layer];
    if (f && f.hp > 0) {
      if (remaining >= f.hp) {
        remaining -= f.hp;
        f.hp = 0;
      } else {
        f.hp -= remaining;
        remaining = 0;
      }
    }
  }
}

// 主伤害管线
// opts: { isBasic, sourceId, ignoreFort, lifesteal, reflectable=true }
export function applyDamage(state, targetId, amount, opts = {}) {
  const t = getHero(state, targetId);
  if (!t || t.dead || amount <= 0) return;

  // 绕过工事（地道战/拆迁/白衣渡江/死门等）
  if (opts.ignoreFort) {
    hitHero(state, targetId, amount, opts);
    return;
  }

  // 农夫车道模型：走专门的车道挡伤管线
  if (t.lanes && t.lanes.length) {
    applyDamageLanes(state, targetId, amount, opts);
    return;
  }

  // 工事违章（警察开罚单）：本回合工事失效，伤害直击本体
  if (hasStatusLocal(t, 'fortDisabled')) {
    hitHero(state, targetId, amount, opts);
    return;
  }

  let remaining = amount;

  // far 工事
  if (t.fortFar && t.fortFar.hp > 0) {
    if (opts.isBasic && t.fortFar.effect === 'reflect_first' && !t.fortFar.reflectUsed) {
      t.fortFar.reflectUsed = true;
      if (opts.sourceId != null) {
        applyDamage(state, opts.sourceId, amount, { isBasic: false, reflectable: false });
      }
      return; // 古堡本次不掉血
    }
    if (remaining >= t.fortFar.hp) {
      remaining -= t.fortFar.hp;
      t.fortFar.hp = 0; // far 不溢出，多余消失
      remaining = 0;
    } else {
      t.fortFar.hp -= remaining;
      remaining = 0;
    }
  }

  // near 工事
  if (remaining > 0 && t.fortNear && t.fortNear.hp > 0) {
    if (opts.isBasic && t.fortNear.effect === 'reflect_first' && !t.fortNear.reflectUsed) {
      t.fortNear.reflectUsed = true;
      if (opts.sourceId != null) {
        applyDamage(state, opts.sourceId, amount, { isBasic: false, reflectable: false });
      }
      return;
    }
    if (remaining >= t.fortNear.hp) {
      const overflow = remaining - t.fortNear.hp;
      t.fortNear.hp = 0;
      remaining = Math.floor(overflow / 2); // near 溢出到 hero 减半
    } else {
      t.fortNear.hp -= remaining;
      remaining = 0;
    }
  }

  // hero 本体
  if (remaining > 0) {
    hitHero(state, targetId, remaining, opts);
  }
}
