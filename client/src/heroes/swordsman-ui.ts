// ============================================================
// 剑客前端插件（swordsman-ui.ts）
// 普通模式：攻击时弹「是否发动剑仙追加」对话框，可另选追加目标。
// 沙盒模式：显示「剑客追加」下拉（sandboxFtRow），设攻击时塞 sub.ft。
// 追加目标存 S.followupTarget（通用追击槽，卡牌角标会自动显示）。
// 通过 appCtx 访问 app.ts 运行时 API（S/$/submitAction）。
// ============================================================
import { appCtx } from '../app';
import { heroUi } from '../hero-ui-core';

// 剑客攻击对话框：问是否追加剑仙 → 选是则选目标
function showDialog(attackTarget: any, enemies: any[], callback: any) {
  const old = document.getElementById('swordDialog');
  if (old) old.remove();
  const dlg = document.createElement('div');
  dlg.id = 'swordDialog';
  dlg.className = 'overlay';
  let state = 0;
  const render = () => {
    dlg.innerHTML =
      state === 0
        ? `<div class="box modal-box"><div class="modal-title">⚔ 攻击 ${enemies.find((e) => e.id === attackTarget)?.name || ''}</div>
          <p style="margin:12px 0;font-size:14px;color:var(--text)">剑仙命中英雄后追加半伤，是否发动？</p>
          <div class="btn-row" style="justify-content:center"><button id="swdYes" class="primary">✅ 发动</button><button id="swdNo" class="ghost">⏭ 不发动</button></div></div>`
        : `<div class="box modal-box"><div class="modal-title">🎯 选择剑仙追加目标</div>
          <div class="btn-row" style="justify-content:center;flex-wrap:wrap;gap:6px">${enemies
            .map((e) => `<button class="swdTarget" data-id="${e.id}">${e.name}</button>`)
            .join('')}</div>
          <div class="btn-row" style="justify-content:center;margin-top:8px"><button id="swdSkip" class="ghost">同主目标(${enemies.find((e) => e.id === attackTarget)?.name || ''})</button></div></div>`;
    document.body.appendChild(dlg);
    if (state === 0) {
      appCtx.$('swdYes').onclick = () => {
        state = 1;
        dlg.innerHTML = '';
        render();
      };
      appCtx.$('swdNo').onclick = () => {
        dlg.remove();
        callback(false, null);
      };
    } else {
      [...dlg.querySelectorAll('.swdTarget')].forEach((b: any) => {
        b.onclick = () => {
          const id = parseInt(b.dataset.id);
          dlg.remove();
          callback(true, id);
        };
      });
      appCtx.$('swdSkip').onclick = () => {
        dlg.remove();
        callback(true, attackTarget);
      };
    }
  };
  render();
}

heroUi.register('swordsman', {
  resetRound() {
    const row = appCtx.$('sandboxFtRow');
    if (row) row.classList.add('hidden');
  },

  // 普通模式攻击接管：弹剑仙对话框后再提交
  onAttackButton(target: any, enemies: any[]) {
    showDialog(target, enemies, (useFt: boolean, ftTarget: any) => {
      appCtx.S.followupTarget = useFt ? ftTarget : undefined;
      appCtx.submitAction({ type: 'attack', target, sub: { ft: appCtx.S.followupTarget } });
    });
    return true; // 已接管提交
  },

  // 沙盒面板：操控剑客时显示追加目标下拉，否则隐藏
  panelRendered(activeHeroId: string, ctx: any) {
    const row = appCtx.$('sandboxFtRow');
    if (!row) return;
    if (ctx.mode !== 'sandbox' || activeHeroId !== 'swordsman') {
      row.classList.add('hidden');
      return;
    }
    const others = (ctx.alive || []).filter((e: any) => e.id !== appCtx.S.activeActor);
    if (others.length === 0) {
      row.classList.add('hidden');
      return;
    }
    row.classList.remove('hidden');
    const sel = appCtx.$('sandboxFtSel');
    sel.innerHTML = '<option value="">默认(同主目标)</option>';
    others.forEach((e: any) => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.name;
      sel.appendChild(o);
    });
    sel.onchange = () => {
      appCtx.S.followupTarget = sel.value ? parseInt(sel.value) : null;
    };
  },

  // 沙盒设攻击时塞追加目标
  transformSandboxAction(a: any, type: string) {
    if (type === 'attack' && appCtx.S.followupTarget != null) a.sub = { ft: appCtx.S.followupTarget };
  },
});
