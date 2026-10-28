// 蓄力伤害表（已修订，保证 D>=1 单调递增，保留"存少损耗/存多利息"）
// k = 蓄力层数（0=不蓄力直接打出, 1..4 = 蓄第1~4次后打出，k=4 强制打出）
// 公式: [D, D+1, 2D, 3D+2, 6D]
export function chargeDamage(D, k) {
  const table = [D, D + 1, 2 * D, 3 * D + 2, 6 * D];
  const idx = Math.max(0, Math.min(4, k | 0));
  return table[idx];
}

export const MAX_CHARGE = 4; // 蓄到第 4 次必须打出
