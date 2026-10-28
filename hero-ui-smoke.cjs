// HeroUI 前端插件框架冒烟测试 (CommonJS)
const { JSDOM } = require('jsdom');
const { readFileSync } = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = 'D:/workbudy/2026-07-18-11-51-47/luanshi';
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
  <div id="toast" class="hidden"></div>
  <div id="mineStatus" style="display:none"></div>
  <div id="sandboxMineStatus" style="display:none"></div>
  <div id="actionBtns"></div>
  <div id="sandboxBtns"></div>
  <div id="board"></div>
  <div id="sandboxFtRow" class="hidden"><select id="sandboxFtSel"></select></div>
  <div id="sandboxActors"></div>
</body></html>`;

const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
const { window } = dom;
const { document } = window;

const submitted = [];
const toasts = [];
window.S = {
  sandbox: false, pid: '1', activeActor: '1', myHeroId: 'miner',
  awaitingAction: true, chosenActionType: null, followupTarget: null,
  sandboxActions: {},
  snapshot: {
    players: [
      { id: '1', heroId: 'miner', resources: { ore: 3 } },
      { id: '2', heroId: 'swordsman' },
    ],
  },
  heroes: [
    { id: 'miner', name: '矿工', maxHp: 10, atk: 4, fort: '爆裂矿车', skills: [{ name: '下井', target: 'none' }, { name: '地道战', target: 'enemy' }] },
    { id: 'swordsman', name: '剑客', maxHp: 10, atk: 6, fort: '葫芦', skills: [{ name: '剑仙', target: 'none' }] },
  ],
};
window.$ = (id) => document.getElementById(id);
window.toast = (m) => toasts.push(m);
window.show = (id) => { const e = document.getElementById(id); if (e) e.classList.remove('hidden'); };
window.hide = (id) => { const e = document.getElementById(id); if (e) e.classList.add('hidden'); };
window.submitAction = (action) => submitted.push(action);
window.renderBoard = () => {};

const ctx = dom.getInternalVMContext();
vm.runInContext(read('public/heroes/hero-ui-core.js'), ctx, { filename: 'hero-ui-core.js' });
vm.runInContext(read('public/heroes/miner-ui.js'), ctx, { filename: 'miner-ui.js' });
vm.runInContext(read('public/heroes/swordsman-ui.js'), ctx, { filename: 'swordsman-ui.js' });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function buildBoard() {
  const board = window.$('board');
  board.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'pcard'; card.dataset.pid = '2';
  card.innerHTML = `<div class="fort-block ok" data-fort-layer="fortFar" data-fort-name="爆裂矿车"><div class="fort-label">远 6/6</div></div>`;
  board.appendChild(card);
  return board;
}

// ===== 1. 框架核心 =====
section('HeroUI 框架核心（register/get/call/callAll）');
ok('register 注册 miner', typeof window.HeroUI.get('miner') === 'object');
ok('register 注册 swordsman', typeof window.HeroUI.get('swordsman') === 'object');
ok('call 未知英雄安全返回 undefined', window.HeroUI.call('nonexist', 'resetRound') === undefined);
let callAllCount = 0;
window.HeroUI.register('__t', { resetRound() { callAllCount++; } });
window.HeroUI.callAll('resetRound');
ok('callAll 命中所有插件', callAllCount === 1);
delete window.HeroUI._plugins['__t'];

// ===== 2. 矿工·普通模式 下井 =====
section('矿工·普通模式 下井 全流程');
window.S.sandbox = false; window.S.myHeroId = 'miner'; window.S.pid = '1';
window.S.snapshot.players[0].resources.ore = 3;
window.S.chosenActionType = null;
const board = buildBoard();
const ctxN = { mode: 'normal', snap: window.S.snapshot, container: window.$('actionBtns'), alive: [] };

const skillHandled = window.HeroUI.call('miner', 'onSkillButton', { skillId: '下井' }, ctxN);
ok('onSkillButton(下井) 接管返回 true', skillHandled === true);
ok('onSkillButton 提示点工事', toasts.some((t) => t.includes('工事')));

window.HeroUI.call('miner', 'onBoardRender', board, window.S.snapshot);
const fb = board.querySelector('.fort-block.ok');
ok('onBoardRender 给工事块绑可点样式', fb.style.cursor === 'pointer');
ok('onBoardRender 给工事块绑 onclick', typeof fb.onclick === 'function');

fb.onclick({ stopPropagation() {}, preventDefault() {} });
const dlg = document.getElementById('minerOpDlg');
ok('点击工事块弹出下井对话框', !!dlg);
window.$('mo1').click();
ok('加固后 完成下井 按钮出现', !!window.$('actionBtns').querySelector('[data-miner-done]'));
ok('加固后 ore 状态显示已安排 1/2', window.$('mineStatus').innerHTML.includes('1/2'));
ok('普通模式互斥锁定 chosenActionType=下井', window.S.chosenActionType === '下井');

window.$('actionBtns').querySelector('[data-miner-done]').click();
ok('提交动作 type=skill', submitted.length === 1 && submitted[0].type === 'skill');
ok('提交动作 skillId=下井', submitted[0].skillId === '下井');
ok('提交动作 sub.ops 含 1 次加固(远位)',
  submitted[0].sub && submitted[0].sub.ops.length === 1 && submitted[0].sub.ops[0].op === 1 && submitted[0].sub.ops[0].layer === 'fortFar');

// ===== 3. 矿工·沙盒模式 下井 =====
section('矿工·沙盒模式 下井 写入 sandboxActions');
// 模拟真实流程：上一回合提交后 callAll('resetRound') 会清空插件私有 st.ops
window.HeroUI.callAll('resetRound');
window.S.sandbox = true; window.S.activeActor = '1'; window.S.sandboxActions = {};
window.S.snapshot.players[0].resources.ore = 3;
const board2 = buildBoard();
const ctxS = { mode: 'sandbox', snap: window.S.snapshot, container: window.$('sandboxBtns'), alive: [] };
window.HeroUI.call('miner', 'onBoardRender', board2, window.S.snapshot);
const fb2 = board2.querySelector('.fort-block.ok');
fb2.onclick({ stopPropagation() {}, preventDefault() {} });
window.$('mo2').click();
ok('沙盒升级后 sandboxActions[1] 为 下井', window.S.sandboxActions['1'] && window.S.sandboxActions['1'].type === 'skill' && window.S.sandboxActions['1'].skillId === '下井');
ok('沙盒升级 sub.ops 含 1 次升级(op=2)', window.S.sandboxActions['1'].sub.ops[0].op === 2);
ok('沙盒升级无数值 target', window.S.sandboxActions['1'].target === undefined);

// ===== 4. 剑客·普通模式 攻击追加 =====
section('剑客·普通模式 攻击 → 剑仙追加对话框');
window.S.sandbox = false; window.S.myHeroId = 'swordsman'; submitted.length = 0;
const enemies = [{ id: '2', name: 'B' }, { id: '3', name: 'C' }];
const handled = window.HeroUI.call('swordsman', 'onAttackButton', '2', enemies, {});
ok('onAttackButton 接管返回 true', handled === true);
const swd = document.getElementById('swordDialog');
ok('弹出剑仙对话框', !!swd);
window.$('swdYes').click();
ok('点击发动后出现选目标', !!document.querySelector('.swdTarget'));
window.document.querySelector('.swdTarget[data-id="3"]').click();
ok('提交攻击带 sub.ft=3', submitted.length === 1 && submitted[0].type === 'attack' && submitted[0].sub && submitted[0].sub.ft === 3);

// ===== 5. 剑客·沙盒 transformSandboxAction =====
section('剑客·沙盒 transformSandboxAction 注入 sub.ft');
window.S.sandbox = true; window.S.followupTarget = 5;
const a = { type: 'attack', target: '2' };
window.HeroUI.call('swordsman', 'transformSandboxAction', a, 'attack');
ok('沙盒攻击被注入 sub.ft=5', a.sub && a.sub.ft === 5);

// ===== 6. panelRendered 分发 =====
section('panelRendered 分发（按 activeHeroId 显示专属控件）');
window.S.sandbox = false; window.S.myHeroId = 'miner';
window.HeroUI.callAll('panelRendered', 'miner', { mode: 'normal', snap: window.S.snapshot, container: window.$('actionBtns'), alive: [] });
ok('矿工 panelRendered 显示 mineStatus', window.$('mineStatus').style.display === 'block');
window.HeroUI.callAll('panelRendered', 'swordsman', { mode: 'normal', snap: window.S.snapshot, container: window.$('actionBtns'), alive: [] });
ok('剑客 panelRendered(普通) 不显示沙盒追加行', window.$('sandboxFtRow').classList.contains('hidden'));

window.S.sandbox = true; window.S.activeActor = '2';
window.HeroUI.callAll('panelRendered', 'swordsman', { mode: 'sandbox', snap: window.S.snapshot, container: window.$('sandboxBtns'), alive: [{ id: '1' }, { id: '2' }, { id: '3' }] });
ok('剑客沙盒 panelRendered 显示追加行', !window.$('sandboxFtRow').classList.contains('hidden'));

// ===== 7. resetRound 清理 =====
section('resetRound 清理两插件私有状态');
window.HeroUI.callAll('resetRound');
ok('resetRound 后 mineStatus 隐藏', window.$('mineStatus').style.display === 'none');
ok('resetRound 后 沙盒追加行隐藏', window.$('sandboxFtRow').classList.contains('hidden'));

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
