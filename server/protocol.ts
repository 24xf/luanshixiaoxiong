// 客户端 / 服务器 共用协议类型（服务器权威，客户端只发"意图"）
// 元素集可配置：五元（数/物/化/生/计）或三元（石头/剪刀/布）

export type Element = string; // 元素 id（具体取值取决于本局 elementSet）
export const ELEMENT_SET: string[] = ['数', '物', '化', '生', '计'];

// 对局可选元素集（前端建房间时展示）
export const ELEMENT_SETS: Record<string, string[]> = {
  five: ['数', '物', '化', '生', '计'],
  three: ['石头', '剪刀', '布'],
};
export const DEFAULT_ELEMENT_SET = 'five';

export type ActionType = 'attack' | 'charge' | 'build' | 'skill' | 'pass';

// 客户端提交的"行动意图"（不含任何结算结果，服务器才算）
export interface Action {
  type: ActionType;
  target?: number;   // 攻击/技能/蓄力 的目标 pid
  skillId?: string;  // 技能类行动
  sub?: any;         // 技能子选项载荷（如 矿工下井的 ops、剑客追加的 ft）；服务器权威校验，客户端不可信
}

// 玩家公开视图（每回合下发给全部客户端；转盘游戏信息基本全公开）
export interface PlayerView {
  id: number;
  heroId: string;
  name: string;
  seat: number;
  team: number;
  hp: number;
  maxHp: number;
  online: boolean;
  dead: boolean;
  isBot: boolean;
  charge: number;
  fortFar: { name: string; hp: number; maxHp: number } | null;
  fortNear: { name: string; hp: number; maxHp: number } | null;
  lanes: { far: { name: string; hp: number; maxHp: number } | null; near: { name: string; hp: number; maxHp: number } | null }[] | null;
  resources: Record<string, number>;
  anaesthetized: number;
  arrested: boolean;
  fortDisabled: boolean;         // 工事违章：本回合不可新建工事（警察技能）
  jailed: boolean;               // 被关警车：本回合免疫且不可行动（警察技能）
  wins: number;                  // 本局胜场（积分）
  throwEl: string | null;        // 本回合出的拳
  result: 'win' | 'lose' | null; // 本回合输赢
}

export interface StateSnapshot {
  turn: number;
  phase: string;
  mode: string;
  winner: number | null;
  suddenDeath: boolean;
  lastEvent: string | null;
  // 事件/环境效果状态（客户端据此显示提示条，避免"操作被服务器忽略却无感知"）
  forceRandomNext: boolean;       // 元素暴走：下回合全员随机元素
  skipActionsThisRound: boolean;  // 太平轮休：本回合无人行动
  mirrorPair: number[] | null;    // 镜像结界：结界内两人仅可互攻
  pendingEvent: number | string | null; // 平局抽定但尚未公布的随机事件
  elements: string[];
  paused: boolean;
  players: PlayerView[];
}

// 房间内（开局前）成员视图
export interface RoomMemberView {
  pid: number;
  heroId: string | null;
  name: string;
  isBot: boolean;
  online: boolean;
}
export interface RoomStateMsg {
  roomId: string;
  hostPid: number;
  elementSet: string;
  sandbox: boolean;
  members: RoomMemberView[];
  canStart: boolean;
  playerCount: number;
  teamStr: string | null;
  fightMode: 'open' | 'secret';
}

// 每回合结算广播（每个人出了什么、输赢）
export interface RoundResultMsg {
  turn: number;
  throws: Record<number, string>;
  results: Record<number, 'win' | 'lose'>;
  winners: number[];
  // 本回合事件/环境效果（applyActions 之前快照，客户端据此显示提示条）
  events?: {
    forceRandomNext: boolean;
    skipActionsThisRound: boolean;
    mirrorPair: number[] | null;
    pendingEvent: number | string | null;
    lastEvent: number | string | null;
    jailed: number[];        // 被关警车的玩家 pid
    fortDisabled: number[];  // 工事违章的玩家 pid
  };
}

// ---- 客户端 → 服务器 ----
export interface CreateRoomMsg { name?: string; elementSet?: 'five' | 'three'; sandbox?: boolean; }
export interface JoinRoomMsg { roomId: string; name?: string; }
export interface ChooseHeroMsg { token: string; roomId: string; heroId: string; }
export interface RemoveMemberMsg { token: string; roomId: string; pid: number; }
export interface StartGameMsg { roomId: string; mode?: 'free' | 'team'; teamConfig?: string; }
export interface SubmitThrowMsg { token: string; roomId: string; element: Element; }
export interface SubmitActionMsg { token: string; roomId: string; action: Action; playerId?: number; }
export interface ReconnectMsg { token: string; roomId: string; }
export interface PauseMsg { token: string; roomId: string; }
export interface ResumeMsg { token: string; roomId: string; }

// ---- 服务器 → 客户端 ----
export interface RoomEnterAck {
  roomId: string;
  playerId: number;
  token: string;
  isHost: boolean;
  state: RoomStateMsg;
}
