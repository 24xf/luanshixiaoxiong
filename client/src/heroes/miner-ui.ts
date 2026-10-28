// ============================================================
// 矿工前端插件（miner-ui.ts）
// 下井交互：点任意英雄的存活工事块 → 弹「①加固 / ②升级」对话框，
// 每回合最多安排 2 次；矿石状态显示；普通模式「完成下井」按钮。
// 私有状态 st.ops 取代旧全局 S.mineOps。删除本文件即禁用矿工特殊交互。
// 通过 appCtx 访问 app.ts 运行时 API（S/$/toast/submitAction/renderBoard）。
// ============================================================
import { appCtx } from '../app';
import { heroUi } from '../hero-ui-core';

const st = { ops: [] as any[] }; // 本回合下井操作队列 [{target, layer, op}]

const actorPid = () => (appCtx.S.sandbox ? appCtx.S.activeActor : appCtx.S.pid);
const oreOf = (snap: any) =>
  (snap?.players.find((p: any) => p.id === actorPid())?.resources?.ore) || 0;

function updateStatus(snap: any) {
  const el = appCtx.$(appCtx.S.sandbox ? 'sandboxMineStatus' : 'mineStatus');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML =
    `⛏矿石:${oreOf(snap)} | 已安排:${st.ops.length}/2` +
    st.ops
      .map(
        (o, i) =>
          ` <span class="badge sa">${i + 1}.${o.op === 1 ? '加固' : '升级'}${o.layer === 'fortFar' ? '远' : '近'}位</span>`,
      )
      .join('');
}

function hideStatus() {
  const a = appCtx.$('mineStatus');
  if (a) a.style.display = 'none';
  const b = appCtx.$('sandboxMineStatus');
  if (b) b.style.display = 'none';
}

function appendDoneBtn(container: any) {
  if (container.querySelector('[data-miner-done]')) return;
  const db = document.createElement('button');
  db.dataset.minerDone = '1';
  db.textContent = '✅ 完成下井';
  db.className = 'primary';
  db.onclick = () => appCtx.submitAction({ type: 'skill', skillId: '下井', sub: { ops: st.ops } });
  container.appendChild(db);
}

// 点工事块 → 弹加固/升级对话框（普通/沙盒共用；可叉掉或点外部关闭）
function openDialog(tgtPid: any, layer: any, name: any, snap: any) {
  if (st.ops.length >= 2) return appCtx.toast('下井已达上限（每回合最多2次）');
  const ore = oreOf(snap);
  if (ore < 1) return appCtx.toast('矿石不足，无法下井');
  const old = document.getElementById('minerOpDlg');
  if (old) old.remove();
  const dlg = document.createElement('div');
  dlg.className = 'overlay';
  dlg.style.zIndex = '400';
  dlg.id = 'minerOpDlg';
  dlg.innerHTML = `<div class="box modal-box"><div class="modal-title">🛡 ${name}</div>
      <div style="margin:12px 0;line-height:1.8;font-size:13px">
        <strong>①加固</strong>：消耗 1⛏ 此工事 +3 血 (可突破上限)<br>
        <strong>②升级</strong>：消耗 3⛏ 此工事 +5 血，该英雄以后建${name}永久+5血
        <div style="margin-top:6px;color:var(--muted);font-size:12px">⛏矿石:${ore} | 已安排:${st.ops.length}/2</div>
      </div>
      <div class="btn-row" style="justify-content:center;gap:8px">
        <button id="mo1" class="primary" ${ore < 1 ? 'disabled style="opacity:.4"' : ''}>①加固 (1⛏)</button>
        <button id="mo2" class="secondary" ${ore < 3 ? 'disabled style="opacity:.4"' : ''}>②升级 (3⛏)</button>
        <button id="moClose" class="ghost">✕ 取消</button>
      </div></div>`;
  document.body.appendChild(dlg);
  dlg.onclick = (e: any) => {
    if (e.target === dlg) dlg.remove();
  };
  const close = () => dlg.remove();
  appCtx.$('mo1').onclick = () => {
    close();
    addOp(tgtPid, layer, 1, snap);
  };
  appCtx.$('mo2').onclick = () => {
    close();
    addOp(tgtPid, layer, 2, snap);
  };
  appCtx.$('moClose').onclick = close;
}

function addOp(tgtPid: any, layer: any, op: any, snap: any) {
  st.ops.push({ target: tgtPid, layer, op });
  if (appCtx.S.sandbox) {
    // 沙盒：写入 sandboxActions，结算时统一提交
    const pid = appCtx.S.activeActor;
    const a = appCtx.S.sandboxActions[pid] || {};
    a.type = 'skill';
    a.skillId = '下井';
    a.sub = { ops: [...st.ops] };
    delete a.target; // target:'none' 的技能不能带数值目标
    appCtx.S.sandboxActions[pid] = a;
  } else {
    // 普通模式：锁定互斥 + 显示完成按钮
    appCtx.S.chosenActionType = '下井';
    [...appCtx.$('actionBtns').children].forEach((b: any) => {
      if (b.dataset.actionType && b.dataset.actionType !== '下井') b.disabled = true;
    });
    appendDoneBtn(appCtx.$('actionBtns'));
  }
  updateStatus(snap);
  if (appCtx.S.snapshot) appCtx.renderBoard(appCtx.S.snapshot); // 重绘以更新工事块可点状态
}

heroUi.register('miner', {
  resetRound() {
    st.ops = [];
    hideStatus();
  },

  onSkillButton(d: any) {
    if (d.skillId !== '下井') return false;
    if (st.ops.length >= 2) {
      appCtx.toast('下井已达上限');
      return true;
    }
    appCtx.toast('👆 点击任意英雄的防御工事块即可操作', 1500);
    return true; // 已接管，不走默认技能提交
  },

  panelRendered(activeHeroId: string, ctx: any) {
    if (activeHeroId !== 'miner') {
      hideStatus();
      return;
    }
    updateStatus(ctx.snap);
    if (ctx.mode === 'normal' && st.ops.length > 0) appendDoneBtn(ctx.container);
  },

  onBoardRender(board: any, snap: any) {
    if (st.ops.length >= 2) return;
    [...board.querySelectorAll('.fort-block.ok')].forEach((fb: any) => {
      const parentCard = fb.closest('.pcard');
      if (!parentCard) return;
      const pid = parseInt(parentCard.dataset.pid);
      fb.style.cursor = 'pointer';
      fb.title = '点击对此工事使用下井';
      fb.dataset.targetHero = pid;
      fb.onclick = (e: any) => {
        e.stopPropagation();
        e.preventDefault();
        const layer = fb.dataset.fortLayer;
        if (!layer) return;
        openDialog(parseInt(fb.dataset.targetHero), layer, fb.dataset.fortName, snap);
      };
    });
  },
});
