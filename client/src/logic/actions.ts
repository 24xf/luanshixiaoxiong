// 前端纯逻辑（#16 抽取，供 Vitest 单测 + app.ts 复用）
// 这些函数不依赖 DOM，只根据英雄元数据计算声明式动作列表 / 技能目标。
// 单一数据源：普通模式与沙盒模式的按钮渲染都来自 buildActionSchema。

export interface ActionSchemaItem {
  key: string;
  label: string;
  actionType: string;
  skillId?: string;
  target?: string;
  ghost?: boolean;
}

interface SkillDef {
  name: string;
  target?: string;
}

function normalizeSkill(s: unknown): SkillDef {
  if (typeof s === 'string') return { name: s };
  if (s && typeof s === 'object' && typeof (s as SkillDef).name === 'string') {
    return s as SkillDef;
  }
  return { name: String(s) };
}

export function heroSkillsMeta(heroes: any[], heroId: string): any[] {
  const h = (heroes || []).find((x) => x && x.id === heroId);
  return (h && h.skills) || [];
}

export function skillNamesMeta(heroes: any[], heroId: string): string[] {
  return heroSkillsMeta(heroes, heroId).map((s) => normalizeSkill(s).name);
}

export function skillTargetMeta(heroes: any[], heroId: string, skillId: string): string {
  const sk = heroSkillsMeta(heroes, heroId)
    .map(normalizeSkill)
    .find((s) => s.name === skillId);
  if (!sk) return 'enemy';
  return sk.target || 'enemy';
}

export function buildActionSchema(heroId: string, heroes: any[]): ActionSchemaItem[] {
  const hero = (heroes || []).find((h) => h && h.id === heroId) || {};
  const schema: ActionSchemaItem[] = [
    { key: 'attack', label: '⚔攻击', actionType: 'attack' },
    { key: 'charge', label: '⚡蓄力', actionType: 'charge' },
  ];
  if (hero.fort || hero.lanes) {
    schema.push({ key: 'build', label: '🔨建造', actionType: 'build' });
  }
  for (const sk of skillNamesMeta(heroes, heroId)) {
    schema.push({
      key: 'skill',
      skillId: sk,
      label: `✨${sk}`,
      target: skillTargetMeta(heroes, heroId, sk),
      actionType: sk,
    });
  }
  schema.push({ key: 'pass', label: '⏭跳过', actionType: 'pass', ghost: true });
  return schema;
}
