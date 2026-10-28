import { describe, it, expect } from 'vitest';
import {
  buildActionSchema,
  skillNamesMeta,
  skillTargetMeta,
  heroSkillsMeta,
  type ActionSchemaItem,
} from './actions';

// 镜像真实 heroes.json 的 skills 形状（对象数组，含 name/target）
const heroes = [
  {
    id: 'blacksmith',
    name: '铁匠',
    maxHp: 10,
    fort: { far: { hp: 5, maxHp: 5 }, near: { hp: 5, maxHp: 5 } },
    skills: [
      { name: '铸剑', target: 'ally' },
      { name: '重铸', target: 'ally' },
      { name: '断剑', target: 'ally' },
      { name: '锻甲', target: 'ally' },
    ],
  },
  {
    id: 'merchant',
    name: '商人',
    maxHp: 8,
    skills: [
      { name: '贿赂', target: 'enemy' },
      { name: '强买强卖', target: 'enemy' },
    ],
  },
  {
    id: 'miner',
    name: '矿工',
    maxHp: 10,
    skills: [
      { name: '下井', target: 'none' },
      { name: '地道战', target: 'enemy' },
    ],
  },
  {
    id: 'swordsman',
    name: '剑客',
    maxHp: 9,
    skills: [{ name: '剑仙', target: 'none' }],
  },
];

function schemaMap(schema: ActionSchemaItem[]): Record<string, ActionSchemaItem> {
  const m: Record<string, ActionSchemaItem> = {};
  // 注意：所有技能的 key 都是 'skill'，真正区分靠 actionType(=技能名)。
  for (const s of schema) m[s.actionType] = s;
  return m;
}

describe('heroSkillsMeta / skillNamesMeta', () => {
  it('返回该英雄的技能名列表', () => {
    expect(skillNamesMeta(heroes, 'blacksmith')).toEqual(['铸剑', '重铸', '断剑', '锻甲']);
    expect(skillNamesMeta(heroes, 'merchant')).toEqual(['贿赂', '强买强卖']);
  });
  it('未知英雄返回空数组', () => {
    expect(heroSkillsMeta(heroes, 'ghost')).toEqual([]);
    expect(skillNamesMeta(heroes, 'ghost')).toEqual([]);
  });
});

describe('skillTargetMeta', () => {
  it('解析对象技能 target', () => {
    expect(skillTargetMeta(heroes, 'blacksmith', '重铸')).toBe('ally');
    expect(skillTargetMeta(heroes, 'merchant', '贿赂')).toBe('enemy');
    expect(skillTargetMeta(heroes, 'miner', '下井')).toBe('none');
  });
  it('未知技能回退 enemy', () => {
    expect(skillTargetMeta(heroes, 'blacksmith', '不存在')).toBe('enemy');
  });
});

describe('buildActionSchema（共享按钮数据源）', () => {
  it('始终含 attack/charge/pass', () => {
    const m = schemaMap(buildActionSchema('merchant', heroes));
    expect(m.attack.actionType).toBe('attack');
    expect(m.charge.actionType).toBe('charge');
    expect(m.pass.actionType).toBe('pass');
    expect(m.pass.ghost).toBe(true);
  });

  it('有 fort 的英雄含建造', () => {
    const m = schemaMap(buildActionSchema('blacksmith', heroes));
    expect(m.build.actionType).toBe('build');
  });

  it('每个技能生成对应按钮且 target 正确', () => {
    const m = schemaMap(buildActionSchema('merchant', heroes));
    expect(m['贿赂'].actionType).toBe('贿赂');
    expect(m['贿赂'].target).toBe('enemy');
    expect(m['强买强卖'].target).toBe('enemy');
  });

  it('target:none 技能也生成按钮（下井）', () => {
    const m = schemaMap(buildActionSchema('miner', heroes));
    expect(m['下井'].actionType).toBe('下井');
    expect(m['下井'].target).toBe('none');
    expect(m['地道战'].target).toBe('enemy');
  });

  it('target:none 的剑仙按钮（剑客）', () => {
    const m = schemaMap(buildActionSchema('swordsman', heroes));
    expect(m['剑仙'].actionType).toBe('剑仙');
    expect(m['剑仙'].target).toBe('none');
  });

  it('技能按钮数量 = 基础2 + 建造(若有) + 技能数 + 跳过1', () => {
    const bs = buildActionSchema('blacksmith', heroes);
    // 2(attack/charge) + 1(build) + 4(skills) + 1(pass) = 8
    expect(bs.length).toBe(8);
    const ms = buildActionSchema('merchant', heroes);
    // 2 + 0(build) + 2(skills) + 1(pass) = 5
    expect(ms.length).toBe(5);
  });
});
