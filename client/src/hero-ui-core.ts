// ============================================================
// 前端英雄 UI 插件框架（hero-ui-core.ts）
// 框架只查表调钩子，不认识任何具体英雄。app.ts 中不允许出现
// if (heroId === 'xxx') 之类的硬编码。
//
// 新英雄接入方式：
//   - 无特殊交互：零前端代码（按钮由 buildActionSchema 自动生成）。
//   - 有特殊交互：新建 client/src/heroes/<hero>-ui.ts，调用
//     heroUi.register('<heroId>', { ...钩子 })，并在 main.ts 里 import 它。
//     不改任何旧英雄文件。
//
// 钩子契约（都可选，运行时才会引用 appCtx 上的 S/toast/$ 等）：
//   resetRound()
//     每回合行动面板初始化及提交/结算后由框架 callAll 调用；
//     清理插件私有回合状态、隐藏自己的专属 DOM。
//   onSkillButton(d, ctx) -> boolean
//     行动面板技能按钮点击时对"当前操控英雄"调用；返回 true 表示
//     已接管（框架不再走默认提交逻辑）。d 为 schema 项。
//   onAttackButton(target, enemies, ctx) -> boolean
//     普通模式攻击按钮点击时调用；返回 true 表示已接管提交。
//   panelRendered(activeHeroId, ctx)
//     行动按钮渲染完成后 callAll 调用（普通+沙盒两模式）。插件根据
//     activeHeroId 是否是自己决定显示/隐藏专属状态区、附加控件。
//   onBoardRender(board, snap)
//     棋盘渲染后对"当前操控英雄"调用；用于绑定棋盘交互（如矿工
//     点工事块）。
//   transformSandboxAction(action, type)
//     沙盒 sandboxSetAction 存入前对该英雄调用；可改写 action
//     （如剑客塞 sub.ft）。
//
// ctx 结构：{ mode: 'normal'|'sandbox', snap, container, alive }
// ============================================================
export const heroUi = {
  _plugins: {} as Record<string, any>,
  register(heroId: string, plugin: any) {
    this._plugins[heroId] = plugin;
  },
  get(heroId: string) {
    return this._plugins[heroId] || null;
  },
  // 调用指定英雄的钩子；无插件或无钩子返回 undefined
  call(heroId: string, hook: string, ...args: any[]) {
    const p = this._plugins[heroId];
    if (p && typeof p[hook] === 'function') return p[hook](...args);
    return undefined;
  },
  // 遍历所有插件调用钩子（如回合重置、面板渲染完成）
  callAll(hook: string, ...args: any[]) {
    for (const id in this._plugins) {
      const p = this._plugins[id];
      if (typeof p[hook] === 'function') p[hook](...args);
    }
  },
};
