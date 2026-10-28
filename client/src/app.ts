'use strict';
import { io } from 'socket.io-client';
import { heroUi } from './hero-ui-core';
import * as auth from './auth';
import {
  skillNamesMeta as _skillNamesMeta,
  skillTargetMeta as _skillTargetMeta,
  buildActionSchema as _buildActionSchema,
} from './logic/actions';

const S: any = {
  socket: null, heroes: [], myHeroId: null, myName: '',
  elementSet: 'five', roomId: null, token: null, pid: null,
  isHost: false, joined: false, members: [], sandbox: false,
  sandboxActions: {}, activeActor: null, snapshot: null,
  elements: ['数', '物', '化', '生', '计'],
  round: { turn: 0, throws: {}, results: {}, winners: [] },
  awaitingThrow: false, awaitingAction: false,
  countdownTimer: null, selectedTarget: null, followupTarget: null,
  logLines: [], paused: false, pendingSkill: null,
  actorLocked: false, // 沙盒：用户手动切过英雄后锁定
  chosenActionType: null, // 当前回合已选行动类型（互斥锁定）
  gameOver: false, // 对局是否已结束（结束后返回大厅不再弹"进度丢失"确认）
};
const $ = (id: string): any => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

let toastTimer: any = null;
let bannerTimer: any = null;
function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function showConnBanner(msg, sticky = false) {
  const b = $('connBanner'); if (!b) return;
  b.textContent = msg; b.classList.remove('hidden');
  if (!sticky) { clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.add('hidden'), 3000); }
}
function skillTargetMeta(heroId: string, skillId: string) { return _skillTargetMeta(S.heroes, heroId, skillId); }
function skillNamesMeta(heroId: string) { return _skillNamesMeta(S.heroes, heroId); }
function saveRoom() { try { localStorage.setItem('ls_room', JSON.stringify({ roomId: S.roomId, token: S.token, joined: true, heroId: S.myHeroId, sandbox: S.sandbox })); } catch {} }
function clearRoom() { try { localStorage.removeItem('ls_room'); } catch {} }

function connect() {
  const socket = io({ transports: ['polling', 'websocket'], upgrade: true, rememberUpgrade: true, timeout: 20000, auth: { token: auth.getToken() || undefined } });
  S.socket = socket;
  socket.on('connect', () => {
    $('conn').textContent = '✓ 已连接'; $('conn').className = 'conn ok';
    showConnBanner('✓ 已连接');
    // 关键：先把英雄元数据拉全（S.heroes），再发 reconnect。
    // 否则硬刷新时 reconnect 回包可能早于 listHeroes 到达，promptAction 里
    // S.heroes 还是空 → 技能/建造/目标按钮全渲染不出来，只剩攻击/蓄力。
    socket.emit('listHeroes', (meta) => {
      S.heroes = meta || []; renderBotSelect();
      afterHeroesLoaded();
    });
    function afterHeroesLoaded() {
    const saved = JSON.parse(localStorage.getItem('ls_room') || 'null');
    if (saved && saved.joined && saved.roomId && saved.token) {
      S.roomId = saved.roomId; S.token = saved.token; S.joined = true;
      // 恢复沙盒模式标记（硬刷新后 JS 状态全丢，必须从 localStorage 拿回）
      if (saved.sandbox) S.sandbox = true;
      socket.emit('reconnect', { token: S.token, roomId: S.roomId }, (ack) => {
        if (!ack || ack.error) { clearRoom(); S.joined = false; S.roomId = null; S.token = null; show('lobby'); hide('room'); hide('game'); return; }
        S.pid = ack.playerId;
        // 服务器也带回 sandbox 标记（双保险，防止 localStorage 丢失）
        if (ack.sandbox) S.sandbox = true;
        if (ack.snapshot) {
          S.snapshot = ack.snapshot;
          // 关键：硬刷新后从 snapshot 恢复 myHeroId（之前丢了导致所有技能/建造按钮消失）
          const me = (ack.snapshot.players || []).find((p) => p.id === S.pid);
          if (me) S.myHeroId = me.heroId;
          applySnapshot(ack.snapshot);
          show('game'); hide('lobby'); hide('room');
          show('btnBackRoom');
          // 沙盒模式优先：不管服务器返回什么 phase/awaitingYou，直接进沙盒面板
          if (S.sandbox) {
            promptSandboxActions([], S.snapshot);
          } else if (ack.phase === 'rps' && ack.awaitingYou) {
            promptThrow();
          } else if (ack.phase === 'action' && (ack.awaitingYou || (ack.winners && ack.winners.includes(S.pid)))) {
            S.winners = ack.winners || [];
            if (S.round) { S.round.throws = (ack.round && ack.round.throws) || {}; S.round.results = (ack.round && ack.round.results) || {}; }
            promptAction();
            // O3 重连若处于行动阶段，补行动倒计时（截止时刻由服务器 reconnect.deadline 带回）
            if (ack.deadline) startCountdown(Math.max(1, (ack.deadline - Date.now()) / 1000), '行动', () => toast('时间到，已AI托管'));
          } else {
            // 不轮到你：显示等待面板
            S.awaitingAction = false; S.awaitingThrow = false;
            hide('throwPanel'); hide('actionPanel'); hide('sandboxPanel'); show('waitPanel');
            $('waitTitle').textContent = ack.phase === 'rps' ? '⏳ 等待其他玩家出拳...' : (ack.phase === 'action' ? '⏳ 等待其他玩家行动...' : '⏳ 等待...');
          }
        } else {
          renderRoomState({ roomId: S.roomId, hostPid: 0, elementSet: S.elementSet, sandbox: false, members: [], canStart: false, playerCount: 10, teamStr: null, fightMode: 'open' });
          show('room'); hide('lobby'); hide('game');
        }
        toast('已重连回房间', 1500);
      });
    }
    }
  });
  socket.on('disconnect', (reason) => { $('conn').textContent = '⚠ 已断开：' + (reason || ''); $('conn').className = 'conn bad'; showConnBanner('⚠ 已断开，正在重连…'); });
  socket.on('connect_error', (err) => { showConnBanner('⚠ 连接失败：' + (err.message || ''), true); });
  socket.on('roomState', (d) => renderRoomState(d));
  socket.on('gameStart', (d) => enterGame(d.snapshot));
  socket.on('roundResult', (d) => onRoundResult(d));
  socket.on('roundStart', (d) => onRoundStart(d));
  socket.on('actionPhase', (d) => onActionPhase(d));
  socket.on('state', (d) => { if (d.snapshot) { S.snapshot = d.snapshot; applySnapshot(d.snapshot); } if (Array.isArray(d.log)) pushLog(d.log); });
  socket.on('memberStatus', (d) => onMemberStatus(d));
  socket.on('paused', () => { S.paused = true; show('pauseOverlay'); hide('btnPause'); show('btnResume'); });
  socket.on('resumed', () => { S.paused = false; hide('pauseOverlay'); show('btnPause'); hide('btnResume'); });
  socket.on('gameOver', (d) => { if (d.snapshot) { S.snapshot = d.snapshot; applySnapshot(d.snapshot); } showGameOver(d); });
}

// ===== #18 Phase2 账号栏 + 登录/注册弹窗 =====
let authMode: 'login' | 'register' = 'login';

// 重新握手：更新 socket.auth 后断开重连，使服务器按新 token 重新鉴权（不刷新页面）。
function reauthSocket() {
  if (!S.socket) return;
  S.socket.auth = { token: auth.getToken() || undefined };
  try { S.socket.disconnect(); S.socket.connect(); } catch { /* 忽略 */ }
}

function renderAccountBar() {
  const bar = $('accountBar');
  if (!bar) return;
  const acc = auth.getAccount();
  if (acc) {
    bar.innerHTML = `<span class="ab-user">👤 ${acc.displayName || acc.username}</span><button id="btnProfile" class="ghost small">📊 档案</button><button id="btnLogout" class="ghost small">退出</button>`;
    $('btnProfile').onclick = gotoProfile;
    $('btnLogout').onclick = async () => {
      await auth.logout();
      reauthSocket();
      renderAccountBar();
      toast('已退出登录', 1500);
    };
  } else {
    bar.innerHTML = `<button id="btnShowLogin" class="ghost small">🔑 登录 / 注册</button>`;
    $('btnShowLogin').onclick = () => openAuthModal('login');
  }
}

// #18 Phase3：渲染房间码书签面板（大厅内）。未登录或无书签则隐藏。
function renderBookmarks() {
  const panel = $('bookmarksPanel'); if (!panel) return;
  const list = $('bookmarkList'); if (!list) return;
  const acc = auth.getAccount();
  if (!acc || !S.bookmarks || !S.bookmarks.length) { panel.classList.add('hidden'); list.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  list.innerHTML = '';
  S.bookmarks.forEach((b: any) => {
    const row = document.createElement('div'); row.className = 'bm-item';
    const code = document.createElement('span'); code.className = 'bm-code';
    code.textContent = b.room_code + (b.name ? `（${b.name}）` : '');
    const join = document.createElement('button'); join.className = 'ghost small'; join.textContent = '加入';
    join.onclick = () => { $('joinId').value = b.room_code; $('btnJoin').click(); };
    const del = document.createElement('button'); del.className = 'ghost small'; del.textContent = '✕';
    del.onclick = async () => {
      try { await auth.removeBookmark(b.id); S.bookmarks = (S.bookmarks || []).filter((x: any) => x.id !== b.id); renderBookmarks(); }
      catch (e: any) { toast(e?.message || '删除失败'); }
    };
    row.appendChild(code); row.appendChild(join); row.appendChild(del);
    list.appendChild(row);
  });
}

function openAuthModal(mode: 'login' | 'register') {
  authMode = mode;
  $('authErr').textContent = '';
  $('authUser').value = '';
  $('authPass').value = '';
  $('authTitle').textContent = mode === 'login' ? '登录' : '注册';
  $('btnAuthSubmit').textContent = mode === 'login' ? '登录' : '注册';
  $('btnAuthToggle').textContent = mode === 'login' ? '去注册' : '去登录';
  show('authModal');
  setTimeout(() => $('authUser').focus(), 30);
}

function closeAuthModal() { hide('authModal'); }

async function submitAuth() {
  const username = ($('authUser').value || '').trim();
  const password = ($('authPass').value || '').trim();
  if (!username || !password) { $('authErr').textContent = '请输入用户名和密码'; return; }
  $('btnAuthSubmit').disabled = true;
  try {
    const res = authMode === 'login'
      ? await auth.login(username, password)
      : await auth.register(username, password);
    auth.setAuth(res.token, res.account);
    reauthSocket();
    renderAccountBar();
    // 登录后刷新全量档案（收藏/书签/偏好），并默认用账号显示名作为昵称（用户仍可改 playerName）
    const me = await auth.fetchMe();
    if (me && me.account) { auth.setAuth(res.token, me.account); applyProfile(me); }
    if (res.account?.displayName || res.account?.username) {
      const nm = res.account.displayName || res.account.username;
      $('playerName').value = nm;
    }
    closeAuthModal();
    toast(authMode === 'login' ? '登录成功' : '注册成功', 1500);
  } catch (e: any) {
    $('authErr').textContent = e?.message || '操作失败';
  } finally {
    $('btnAuthSubmit').disabled = false;
  }
}

// 登录/注册弹窗按钮绑定（弹窗 DOM 常驻，仅显隐）
$('btnAuthSubmit').onclick = submitAuth;
$('btnAuthToggle').onclick = () => openAuthModal(authMode === 'login' ? 'register' : 'login');
$('authModal').onclick = (e: any) => { if (e.target === $('authModal')) closeAuthModal(); };

// 把 /api/me 返回的全量档案（account/profile/favorites/bookmarks/stats）落到本地状态，并刷新 UI。
function applyProfile(me: any) {
  if (!me) return;
  S.favorites = me.favorites || [];
  S.bookmarks = me.bookmarks || [];
  S.stats = me.stats || null;
  S.prefs = (me.profile && me.profile.prefs) ? me.profile.prefs : {};
  renderBookmarks();
}

// 启动时用 /api/me 校验本地 token 是否仍有效，刷新账号信息；无效则清除。
(async () => {
  const me = await auth.fetchMe();
  if (me && me.account) { auth.setAuth(auth.getToken() || '', me.account); applyProfile(me); }
  else if (me === null) auth.clearAuth();
  renderAccountBar();
  renderBookmarks();
})();

// ===== #18 Phase4 档案页 + 回放播放器 =====
const HERO_EMOJI: Record<string, string> = {
  chef: '👨‍🍳', vampire: '🧛', miner: '⛏️', doctor: '🩺', police: '👮',
  farmer: '🌾', carpenter: '🔨', swordsman: '🗡️', builder: '🏗️', blacksmith: '🔥', merchant: '💰', gambler: '🎲',
};
const MODE_LABEL: Record<string, string> = { free: '乱斗', team: '组队' };
function heroName(id: string): string { return (S.heroes || []).find((h: any) => h.id === id)?.name || id; }
function heroEmoji(id: string): string { return HERO_EMOJI[id] || '🎴'; }

// 打开档案页（需登录；游客引导登录）
function gotoProfile() {
  if (!auth.getAccount()) { openAuthModal('login'); toast('登录后查看档案', 1500); return; }
  hide('lobby'); hide('room'); hide('game'); hide('replay'); show('profile');
  renderProfile();
}

// 返回：尽量恢复到进入档案前的界面，避免误清对局
function closeProfile() {
  hide('profile'); hide('replay');
  if (S.snapshot) show('game');
  else if (S.roomId && S.joined) show('room');
  else show('lobby');
}

async function renderProfile() {
  const body = $('profileBody'); if (!body) return;
  body.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const me = await auth.fetchMe();
    if (!me || !me.account) { body.innerHTML = '<div class="empty">未登录或会话已过期</div>'; return; }
    applyProfile(me); // 刷新 S.favorites / bookmarks / stats
    const acc = me.account;
    const stats = me.stats || null;
    const favorites = me.favorites || [];
    const bookmarks = me.bookmarks || [];

    let html = `<div class="prof-card"><div class="prof-name">👤 ${acc.displayName || acc.username}</div></div>`;

    // —— 战绩统计 ——
    html += `<div class="prof-card"><div class="prof-title">📈 战绩统计</div>`;
    if (stats && stats.games_played > 0) {
      const gp = stats.games_played, w = stats.wins || 0, l = stats.losses || 0, d = stats.draws || 0;
      const wr = Math.round((w / gp) * 100);
      html += `<div class="stat-row"><span>总场次</span><b>${gp}</b></div>`;
      html += `<div class="stat-row"><span>胜 / 负 / 平</span><b>${w} / ${l} / ${d}</b></div>`;
      html += `<div class="stat-row"><span>胜率</span><b>${wr}%</b></div>`;
      html += `<div class="winrate-bar"><i style="width:${wr}%"></i></div>`;
      let hu: any = {};
      try { hu = JSON.parse(stats.hero_usage || '{}'); } catch { hu = {}; }
      const huEntries = Object.entries<any>(hu).filter(([, v]) => v > 0).sort((a: any, b: any) => b[1] - a[1]);
      if (huEntries.length) {
        html += `<div class="prof-subtitle">🦸 英雄使用率</div>`;
        for (const [hid, cnt] of huEntries) {
          const pct = Math.round((cnt / gp) * 100);
          html += `<div class="hero-usage"><span class="hu-name">${heroEmoji(hid)} ${heroName(hid)}</span><div class="hu-bar"><i style="width:${pct}%"></i></div><span class="hu-cnt">${cnt}局</span></div>`;
        }
      }
    } else {
      html += `<div class="empty">还没有对局记录，去打一局吧！</div>`;
    }
    html += `</div>`;

    // —— 英雄收藏 ——
    html += `<div class="prof-card"><div class="prof-title">⭐ 英雄收藏</div>`;
    if (favorites.length) {
      html += `<div class="fav-grid">`;
      favorites.forEach((hid: string) => { html += `<div class="fav-chip">${heroEmoji(hid)} ${heroName(hid)}</div>`; });
      html += `</div>`;
    } else {
      html += `<div class="empty">还没有收藏英雄（大厅选英雄时点 ☆ 即可收藏）</div>`;
    }
    html += `</div>`;

    // —— 房间码书签 ——
    html += `<div class="prof-card"><div class="prof-title">📌 房间码书签</div>`;
    if (bookmarks.length) {
      html += `<div class="bm-list">`;
      bookmarks.forEach((b: any) => {
        html += `<div class="bm-item"><span class="bm-code">${b.room_code}${b.name ? `（${b.name}）` : ''}</span><button class="ghost small" data-join="${b.room_code}">加入</button><button class="ghost small" data-del="${b.id}">✕</button></div>`;
      });
      html += `</div>`;
    } else {
      html += `<div class="empty">还没有房间码书签</div>`;
    }
    html += `</div>`;

    // —— 回放列表 ——
    html += `<div class="prof-card"><div class="prof-title">🎬 对局回放</div><div id="replayList" class="replay-list"><div class="loading">加载中…</div></div></div>`;

    body.innerHTML = html;

    // 书签：加入 / 删除
    body.querySelectorAll('[data-join]').forEach((btn: any) => { btn.onclick = () => { $('joinId').value = btn.dataset.join; $('btnJoin').click(); }; });
    body.querySelectorAll('[data-del]').forEach((btn: any) => { btn.onclick = async () => { try { await auth.removeBookmark(btn.dataset.del); renderProfile(); } catch (e: any) { toast(e?.message || '删除失败'); } }; });

    loadReplayList();
  } catch (e: any) {
    body.innerHTML = `<div class="empty">加载失败：${e?.message || ''}</div>`;
  }
}

async function loadReplayList() {
  const list = $('replayList'); if (!list) return;
  try {
    const r = await auth.getReplays(30);
    const replays = (r && r.replays) || [];
    if (!replays.length) { list.innerHTML = '<div class="empty">还没有回放记录（打一局后自动生成）</div>'; return; }
    const myId = auth.getAccount()?.id;
    list.innerHTML = '';
    replays.forEach((rp: any) => {
      const mode = rp.mode || '';
      const duration = rp.duration_rounds || 0;
      let myResult = '';
      try {
        const players = JSON.parse(rp.players || '[]');
        const me = (players || []).find((p: any) => p.accountId === myId);
        myResult = me ? ({ win: '胜', loss: '负', draw: '平' }[me.result] || '') : '';
      } catch { /* 忽略解析错误 */ }
      const date = new Date(rp.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const row = document.createElement('div'); row.className = 'replay-item';
      row.innerHTML = `<span class="ri-mode">${MODE_LABEL[mode] || mode || '对局'}</span><span class="ri-result ${myResult}">${myResult || '—'}</span><span class="ri-meta">${duration} 回合 · ${date}</span>`;
      row.onclick = () => openReplay(rp.id);
      list.appendChild(row);
    });
  } catch (e: any) {
    list.innerHTML = `<div class="empty">回放加载失败：${e?.message || ''}</div>`;
  }
}

// 回放播放器状态
let replayState: any = null;

async function openReplay(id: string) {
  hide('profile'); show('replay');
  stopReplay();
  try {
    const r = await auth.getReplay(id);
    const rp = r && r.replay;
    if (!rp) { toast('回放不存在'); show('profile'); hide('replay'); return; }
    let meta: any = {};
    try { meta = JSON.parse(rp.events || '{}'); } catch { meta = {}; }
    const stream: any[] = meta.stream || [];
    replayState = { id, meta, stream, idx: 0, timer: null };
    const scr = $('replayScrub'); scr.max = String(Math.max(0, stream.length - 1)); scr.value = '0';
    $('replayTitle').textContent = `🎬 对局回放 · ${MODE_LABEL[meta.mode] || meta.mode || ''} · ${stream.length} 回合`;
    renderReplayTurn(0);
  } catch (e: any) {
    toast('回放加载失败：' + (e?.message || ''));
    show('profile'); hide('replay');
  }
}

function renderReplayTurn(idx: number) {
  if (!replayState) return;
  const stream = replayState.stream;
  const board = $('replayBoard'); const info = $('replayRoundInfo'); const logBox = $('replayLog');
  if (!stream || !stream.length) {
    board.innerHTML = '<div class="empty">该回放无棋谱数据</div>';
    info.innerHTML = ''; logBox.innerHTML = '';
    return;
  }
  idx = Math.max(0, Math.min(stream.length - 1, idx));
  replayState.idx = idx;
  const entry = stream[idx];

  // —— 棋盘（有快照则可视化，否则文字降级）——
  board.innerHTML = '';
  if (entry.snap && entry.snap.players && entry.snap.players.length) {
    entry.snap.players.forEach((p: any) => { board.appendChild(buildCard(p, entry.snap, false)); });
  } else {
    board.innerHTML = '<div class="empty">旧版回放无棋盘快照，仅显示事件流水 →</div>';
  }

  // —— 本回合信息（出拳/结果/事件/赢家）——
  let h = `<div class="ri-head">第 ${entry.turn} 回合</div>`;
  const players = entry.snap?.players || [];
  const rows = players.map((p: any) => {
    const th = entry.throws?.[p.id]; const res = entry.results?.[p.id];
    const cls = res === 'win' ? 'win' : (res === 'lose' ? 'lose' : '');
    const resTxt = res === 'win' ? '🏆' : (res === 'lose' ? '💔' : '');
    return `<span class="rb-item ${cls}">${p.name} ${th || '—'} ${resTxt}</span>`;
  }).join('');
  if (rows) h += `<div class="rb-line">${rows}</div>`;
  const ev = entry.events;
  if (ev) {
    const hints: string[] = [];
    if (ev.forceRandomNext) hints.push('🌪 元素暴走：全员随机');
    if (ev.skipActionsThisRound) hints.push('🌙 太平轮休：无人行动');
    if (ev.mirrorPair && ev.mirrorPair.length === 2 && players.length) {
      const ns = ev.mirrorPair.map((id: number) => players.find((p: any) => p.id === id)?.name).filter(Boolean);
      if (ns.length === 2) hints.push(`🪞 镜像结界：${ns[0]}↔${ns[1]}`);
    }
    if (Array.isArray(ev.jailed) && ev.jailed.length) hints.push('🚓 有人被关警车');
    if (Array.isArray(ev.fortDisabled) && ev.fortDisabled.length) hints.push('🚧 有人工事违章');
    if (hints.length) h += `<div class="ri-events">${hints.map((x: string) => `<span class="eb-item">${x}</span>`).join('')}</div>`;
  }
  if (entry.winners && entry.winners.length) {
    const wn = entry.winners.map((id: number) => players.find((p: any) => p.id === id)?.name).filter(Boolean).join('、');
    if (wn) h += `<div class="ri-winners">🏆 赢家：${wn}</div>`;
  }
  info.innerHTML = h;

  // —— 本回合日志 ——
  const lines = Array.isArray(entry.log) ? entry.log : [];
  logBox.innerHTML = lines.length ? lines.map((l: string) => `<div>· ${l}</div>`).join('') : '<div class="empty">（无日志）</div>';

  // —— 进度条 / 标签 ——
  $('replayScrub').value = String(idx);
  $('replayTurnLabel').textContent = `回合 ${idx + 1} / ${stream.length}`;
}

function replayStep(delta: number) { if (!replayState) return; stopReplay(); renderReplayTurn(replayState.idx + delta); }
function playReplay() {
  if (!replayState || !replayState.stream.length) return;
  if (replayState.timer) return;
  $('btnReplayPlay').textContent = '⏸ 暂停';
  replayState.timer = setInterval(() => {
    if (!replayState) return;
    if (replayState.idx >= replayState.stream.length - 1) { stopReplay(); return; }
    renderReplayTurn(replayState.idx + 1);
  }, 1300);
}
function stopReplay() {
  if (replayState && replayState.timer) { clearInterval(replayState.timer); replayState.timer = null; }
  const b = $('btnReplayPlay'); if (b) b.textContent = '▶ 播放';
}

// 回放播放器按钮接线（DOM 静态存在，模块加载时绑定）
$('btnProfileBack').onclick = closeProfile;
$('btnReplayBack').onclick = () => { stopReplay(); hide('replay'); show('profile'); };
$('btnReplayPrev').onclick = () => replayStep(-1);
$('btnReplayNext').onclick = () => replayStep(1);
$('btnReplayPlay').onclick = () => { if (replayState && replayState.timer) stopReplay(); else playReplay(); };
$('replayScrub').oninput = (e: any) => { stopReplay(); renderReplayTurn(parseInt(e.target.value) || 0); };

// ===== 大厅 =====
$('btnCreate').onclick = () => {
  S.myName = ($('playerName').value || '').trim() || '玩家';
  S.socket.emit('createRoom', { name: S.myName, elementSet: S.elementSet, sandbox: false }, (ack) => {
    if (ack.error) return toast(ack.error);
    enterRoom(ack);
  });
};
$('btnCreateSandbox').onclick = () => {
  S.myName = ($('playerName').value || '').trim() || '测试员';
  S.socket.emit('createRoom', { name: S.myName, elementSet: S.elementSet, sandbox: true }, (ack) => {
    if (ack.error) return toast(ack.error);
    enterRoom(ack);
  });
};
$('btnJoin').onclick = () => {
  const rid = ($('joinId').value || '').trim().toUpperCase();
  if (!rid) return toast('请输入房间号');
  S.myName = ($('playerName').value || '').trim() || '玩家';
  S.socket.emit('joinRoom', { roomId: rid, name: S.myName }, (ack) => {
    if (ack.error) return toast(ack.error);
    enterRoom(ack);
  });
};

// 与游戏同主题的自定义确认弹窗（替换浏览器原生 confirm，风格统一）
function confirmDialog(title, msg, onYes, opts: any = {}) {
  opts = opts || {};
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'confirmDlg';
  ov.innerHTML = `<div class="modal-box">
    <div class="modal-title">${title}</div>
    <div style="margin:14px 0;line-height:1.7;font-size:13px;color:var(--text)">${msg}</div>
    <div class="btn-row" style="justify-content:center;gap:10px;margin-top:10px">
      <button id="cdYes" class="primary">${opts.yesText || '确定'}</button>
      <button id="cdNo" class="ghost">${opts.noText || '取消'}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick = (e) => { if (e.target === ov) { ov.remove(); if (opts.onNo) opts.onNo(); } };
  $('cdYes').onclick = () => { ov.remove(); onYes(); };
  $('cdNo').onclick = () => { ov.remove(); if (opts.onNo) opts.onNo(); };
}

function goHome() {
  // 仅"进行中的对局"返回才弹确认；游戏已结束(胜负已分)直接回大厅不弹
  const inActiveGame = !S.gameOver && S.snapshot;
  if (inActiveGame) {
    confirmDialog('返回大厅', '确定返回大厅？对战进度将丢失。', () => { clearRoom(); resetToLobby(); });
  } else {
    clearRoom(); resetToLobby();
  }
}
const btnBL = $('btnBackLobby'); if (btnBL) btnBL.onclick = goHome;
const btnBR = $('btnBackRoom'); if (btnBR) btnBR.onclick = () => {
  // 进行中返回房间也需确认（仅进行中弹）
  if (!S.gameOver && S.snapshot) {
    confirmDialog('返回房间', '确定返回房间？对战进度将丢失。', () => { hide('game'); show('room'); });
  } else { hide('game'); show('room'); }
};
const btnBHR = $('btnBackHomeFromRoom'); if (btnBHR) btnBHR.onclick = goHome;

function enterRoom(ack) {
  S.roomId = ack.roomId; S.token = ack.token; S.pid = ack.playerId; S.isHost = ack.isHost; S.joined = true;
  saveRoom(); hide('lobby'); hide('game'); hide('btnBackRoom'); show('room');
  $('roomId').textContent = ack.roomId;
  renderRoomState(ack.state);
}
$('btnCopy').onclick = () => { const r = S.roomId; if (navigator.clipboard) navigator.clipboard.writeText(r).then(() => toast('已复制'), () => toast(r)); else toast(r); };

// #18 Phase3：收藏当前房间码（登录后可用；游客引导登录）
$('btnBookmark').onclick = async () => {
  if (!S.roomId) return;
  if (!auth.getAccount()) { openAuthModal('login'); toast('登录后可使用房间码收藏', 1500); return; }
  try {
    const r = await auth.addBookmark(S.roomId);
    if (r && r.id) { S.bookmarks = r.bookmarks || []; renderBookmarks(); toast('已收藏房间码 ' + S.roomId, 1500); }
  } catch (e: any) { toast(e?.message || '收藏失败'); }
};

$('setSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn'); if (!btn) return;
  S.elementSet = btn.dataset.set;
  [...$('setSeg').children].forEach((b) => b.classList.toggle('active', b === btn));
  if (S.roomId && S.token) S.socket.emit('setElement', { token: S.token, roomId: S.roomId, elementSet: S.elementSet });
});

// 游戏配置
$('btnApplyConfig').onclick = () => {
  if (!S.roomId || !S.token) return;
  const pc = parseInt($('cfgPlayerCount')?.value || '10');
  const fs = $('cfgFightMode')?.value || 'open';
  S.socket.emit('setConfig', { token: S.token, roomId: S.roomId, playerCount: pc, fightMode: fs }, (a) => { if (a && a.error) toast(a.error); else toast('配置已保存'); });
};

$('btnBot').onclick = () => {
  if (!S.roomId) return;
  const heroId = $('botHero').value || '';
  S.socket.emit('addBot', { roomId: S.roomId, heroId }, (ack) => { if (ack.error) toast(ack.error); });
};
$('btnBotAddAll').onclick = () => {
  if (!S.roomId) return;
  const taken = new Set((S.members || []).filter((m) => m.heroId).map((m) => m.heroId));
  if (S.sandbox) {
    const myHero = (S.members || []).find((m) => m.pid === S.pid)?.heroId;
    if (!myHero) {
      const first = (S.heroes || []).find((h) => !taken.has(h.id));
      if (first) { taken.add(first.id); S.socket.emit('chooseHero', { token: S.token, roomId: S.roomId, heroId: first.id }, (a) => { if (a && a.error) toast(a.error); }); }
    }
  }
  const free = (S.heroes || []).filter((h) => !taken.has(h.id));
  if (!free.length) return toast('英雄已全部加入');
  free.forEach((h) => S.socket.emit('addBot', { roomId: S.roomId, heroId: h.id }, (ack) => { if (ack && ack.error) toast(ack.error); }));
};
// 一键取消全部机器人（保留真人）
$('btnBotRemoveAll').onclick = () => {
  if (!S.roomId || !S.token) return;
  (S.members || []).filter((m) => m.isBot).forEach((m) => {
    S.socket.emit('removeMember', { token: S.token, roomId: S.roomId, pid: m.pid });
  });
};

$('btnStart').onclick = () => {
  if (!S.roomId) return;
  S.socket.emit('startGame', { roomId: S.roomId, mode: 'free' }, (ack) => { if (ack && ack.error) toast(ack.error); });
};

function takenHeroIds(exceptPid) { return (S.members || []).filter((m) => m.heroId && m.pid !== exceptPid).map((m) => m.heroId); }
function availableHeroes(exceptPid) { const taken = takenHeroIds(exceptPid); return (S.heroes || []).filter((h) => !taken.includes(h.id)); }

function renderRoomState(d) {
  if (!d) return;
  S.roomId = d.roomId; S.elementSet = d.elementSet || S.elementSet;
  S.sandbox = !!d.sandbox; S.members = d.members || [];
  [...$('setSeg').children].forEach((b) => b.classList.toggle('active', b.dataset.set === S.elementSet));
  const isHost = S.pid === d.hostPid;
  show('configRow'); // 配置行始终可见（房主可改，非房主只读）
  if (d.playerCount) $('cfgPlayerCount').value = d.playerCount;
  if (d.fightMode) $('cfgFightMode').value = d.fightMode;
  $('btnApplyConfig').style.display = isHost ? '' : 'none';
  $('hostRow').style.display = isHost ? '' : 'none';
  $('btnStart').style.display = isHost ? '' : 'none';
  $('btnStart').disabled = !d.canStart;
  if (S.sandbox) {
    $('roomHint').textContent = '🧪测试模式：无猜拳，一人操控全部英雄';
    $('btnBot').textContent = '添加测试英雄';
    $('btnBotAddAll').style.display = isHost ? '' : 'none';
    $('btnBotRemoveAll').style.display = isHost ? '' : 'none';
  } else {
    $('roomHint').textContent = '配置游戏 → 选英雄（同英雄不可重复，沙盒除外）';
    $('btnBot').textContent = '加机器人';
    $('btnBotAddAll').style.display = isHost ? '' : 'none';
    $('btnBotRemoveAll').style.display = isHost ? '' : 'none';
  }
  const box = $('memberList'); box.innerHTML = '';
  (S.members || []).forEach((m) => {
    const row = document.createElement('div');
    row.className = 'mrow' + (m.pid === S.pid ? ' me' : '');
    const name = document.createElement('span'); name.className = 'mname';
    if (m.isBot) {
      name.innerHTML = '🤖 机器人';
    } else {
      name.innerHTML = m.name + (m.pid === S.pid ? ' <span class="tag-you">你</span>' : '') + (m.pid === d.hostPid ? ' <span class="mhost">房主</span>' : '');
    }
    let heroPart;
    if (m.pid === S.pid) {
      const sel = document.createElement('select');
      const free = availableHeroes(m.pid);
      const opts = free.slice();
      if (m.heroId && !opts.find((h) => h.id === m.heroId)) opts.unshift(S.heroes.find((h) => h.id === m.heroId));
      opts.forEach((h) => {
        const o = document.createElement('option');
        o.value = h.id; o.textContent = `${h.name}（HP${h.maxHp}·攻${h.atk}${h.fort ? '·' + h.fort : ''}${h.lanes ? '·3路' : ''}）`;
        if (h.id === m.heroId) o.selected = true;
        sel.appendChild(o);
      });
      // #18 Phase3：若账号有上次所选英雄且当前可选，自动选中（首次未选时自动发 chooseHero 让服务器采用）
      const lastHero = S.prefs && S.prefs.lastHero;
      if (lastHero && opts.find((h) => h.id === lastHero)) {
        sel.value = lastHero;
        if (!m.heroId) S.socket.emit('chooseHero', { token: S.token, roomId: S.roomId, heroId: lastHero }, (a) => { if (a && a.error) toast(a.error); });
      }
      sel.onchange = () => {
        S.myHeroId = sel.value;
        S.socket.emit('chooseHero', { token: S.token, roomId: S.roomId, heroId: sel.value }, (a) => { if (a && a.error) toast(a.error); });
        saveRoom();
        auth.updatePrefs({ lastHero: sel.value }).catch(() => {}); // #18 Phase3 记住上次所选英雄
      };
      // #18 Phase3：英雄收藏（☆/★ 切换）
      const favBtn = document.createElement('button');
      favBtn.className = 'ghost small';
      const isFav = (S.favorites || []).includes(sel.value);
      favBtn.textContent = isFav ? '★' : '☆';
      favBtn.title = isFav ? '取消收藏该英雄' : '收藏该英雄';
      favBtn.onclick = async () => {
        try {
          const r = await auth.toggleFavorite(sel.value, !isFav);
          S.favorites = r.favorites || [];
          const nowFav = (S.favorites || []).includes(sel.value);
          favBtn.textContent = nowFav ? '★' : '☆';
          toast(nowFav ? '已收藏' : '已取消收藏', 1200);
        } catch (e: any) { toast(e?.message || '操作失败'); }
      };
      heroPart = document.createElement('span');
      (heroPart as HTMLElement).style.display = 'inline-flex';
      (heroPart as HTMLElement).style.gap = '6px';
      (heroPart as HTMLElement).style.alignItems = 'center';
      heroPart.appendChild(sel); heroPart.appendChild(favBtn);
    } else if (m.heroId) {
      heroPart = document.createElement('span'); heroPart.className = 'mhero';
      heroPart.textContent = S.heroes.find((h) => h.id === m.heroId)?.name || m.heroId;
      if (m.isBot) {
        const cancel = document.createElement('button'); cancel.className = 'ghost'; cancel.textContent = '✕'; cancel.title = '移除';
        cancel.onclick = () => S.socket.emit('removeMember', { token: S.token, roomId: S.roomId, pid: m.pid });
        heroPart.appendChild(document.createTextNode(' ')); heroPart.appendChild(cancel);
      }
    } else { heroPart = document.createElement('span'); heroPart.className = 'mhero'; heroPart.textContent = '未选'; }
    row.appendChild(name); row.appendChild(heroPart);
    box.appendChild(row);
  });
}

function renderBotSelect() {
  const sel = $('botHero'); sel.innerHTML = '';
  (S.heroes || []).forEach((h) => {
    const o = document.createElement('option'); o.value = h.id; o.textContent = h.name;
    sel.appendChild(o);
  });
}

// ===== 对战 =====
function enterGame(snapshot) {
  hide('room'); hide('lobby'); show('game');
  show('btnBackRoom');
  S.gameOver = false;
  S.eventHints = null;
  if (snapshot) { S.snapshot = snapshot; applySnapshot(snapshot); }
  S.logLines = []; $('logBox').innerHTML = '';
  hide('pauseOverlay'); S.paused = false;
  toast('游戏开始！', 1500);
}

function applySnapshot(snap) {
  S.snapshot = snap;
  if (Array.isArray(snap.elements) && snap.elements.length) S.elements = snap.elements;
  S.paused = !!snap.paused;
  if (S.paused) show('pauseOverlay'); else hide('pauseOverlay');
  const phaseTxt = { rps: '猜拳', action: '行动', over: '结束' }[snap.phase] || snap.phase;
  $('turnInfo').textContent = S.sandbox ? `🧪测试·${phaseTxt}` : `第${snap.turn}回·${phaseTxt}${snap.suddenDeath ? '·死斗' : ''}`;
  renderRoundBanner();
  renderEventBanner();
  renderBoard(snap);
}

function renderRoundBanner() {
  const el = $('roundBanner'); const r = S.round;
  if (!r || !r.turn) { el.classList.add('hidden'); return; }
  if (S.sandbox) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const rows = (S.snapshot?.players || []).map((p) => {
    const th = r.throws[p.id]; const res = r.results[p.id];
    const cls = res === 'win' ? 'win' : (res === 'lose' ? 'lose' : '');
    const resTxt = res === 'win' ? '🏆' : (res === 'lose' ? '💔' : '');
    return `<span class="rb-item ${cls}">${p.name} ${th||'—'} ${resTxt}</span>`;
  }).join('');
  el.innerHTML = `<span class="rb-title">第${r.turn}回</span> ${rows}`;
}

// 事件/环境效果提示条：本回合若有随机事件或状态效果，明确告知玩家，
// 避免"操作被服务器忽略却无感知"（如太平轮休整回合无行动、元素暴走全员随机）。
// 数据源为服务端 roundResult.events（applyActions 之前快照，整回合持久）。
function renderEventBanner() {
  const el = $('eventBanner');
  const ev = S.eventHints;
  const snap = S.snapshot;
  // O4 沙盒也渲染事件提示条（仅提示，不影响操作），便于沙盒验证事件效果（如元素暴走/太平轮休/镜像结界）。
  if (!ev) { el.classList.add('hidden'); return; }
  const hints = [];
  if (ev.forceRandomNext) hints.push('🌪 元素暴走：下回合全员随机元素');
  if (ev.skipActionsThisRound) hints.push('🌙 太平轮休：本回合无人行动');
  if (ev.pendingEvent != null) hints.push('🎲 随机事件待触发');
  if (ev.mirrorPair && ev.mirrorPair.length === 2 && snap) {
    const names = ev.mirrorPair.map((id) => snap.players.find((p) => p.id === id)?.name).filter(Boolean);
    if (names.length === 2) hints.push(`🪞 镜像结界：${names[0]} 与 ${names[1]} 仅可互攻`);
  }
  if (snap && Array.isArray(ev.jailed)) {
    if (ev.jailed.includes(S.pid)) hints.push('🚓 你被关警车：本回合免疫且不可行动');
    else hints.push('🚓 有玩家被关警车：免疫且不可行动');
  }
  if (snap && Array.isArray(ev.fortDisabled)) {
    if (ev.fortDisabled.includes(S.pid)) hints.push('🚧 你工事违章：本回合不可新建');
    else hints.push('🚧 有玩家工事违章：本回合不可新建');
  }
  if (hints.length) { el.innerHTML = hints.map((h) => `<span class="eb-item">${h}</span>`).join(''); el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

// ===== 棋盘：自己底边全宽，其余环绕；工事图形化 =====
function renderBoard(snap) {
  const board = $('board'); board.innerHTML = '';
  const players = snap.players || [];
  const me = players.find((p) => p.id === S.pid);
  const others = players.filter((p) => p.id !== S.pid);
  // 自己的卡放在底边（全宽），其余环绕在上/左/右
  others.forEach((p) => { const card = buildCard(p, snap, false); card.dataset.pid = p.id; board.appendChild(card); });
  if (me) { const card = buildCard(me, snap, true); card.dataset.pid = me.id; card.style.order = '9999'; board.appendChild(card); }
  updateTargetHighlight();
  // 英雄插件棋盘交互钩子：当前操控英雄的插件可绑定棋盘元素（如矿工点工事块）
  if (S.awaitingAction && heroUi) {
    const actingHeroId = S.sandbox
      ? snap?.players.find((p) => p.id === S.activeActor)?.heroId
      : S.myHeroId;
    heroUi.call(actingHeroId, 'onBoardRender', board, snap);
  }
}

// 工事图形：远位(外) ── 近位(中) ── [英雄本体]（所有卡牌统一布局）
function fortGraphic(far, near) {
  const fBlock = (fObj, label, layer) => fObj && fObj.hp > 0
    ? `<div class="fort-block ok" data-fort-layer="${layer}" data-fort-name="${fObj.name}"><div class="fort-bar"><i style="width:${(fObj.hp/fObj.maxHp)*100}%"></i></div><div class="fort-label">${label} ${fObj.hp}/${fObj.maxHp}</div></div>`
    : `<div class="fort-block dead" data-fort-layer="${layer}"><div class="fort-label">${label} 💀</div></div>`;
  const empty = (label, layer) => `<div class="fort-block empty" data-fort-layer="${layer}"><div class="fort-label">${label} ⬜</div></div>`;
  return `<div class="fort-row"><span class="fort-arr">←</span>${far ? fBlock(far,'远','fortFar') : empty('远','fortFar')}${near ? fBlock(near,'近','fortNear') : empty('近','fortNear')}<span class="fort-hero">⚔</span></div>`;
}

// 农夫车道：远=稻草人 近=粮食
function lanesGraphic(lanes) {
  let h = '<div class="lanes">';
  (lanes || []).forEach((l, i) => {
    const far = l.far && l.far.hp > 0 ? `远🧑‍🌾${l.far.hp}/${l.far.maxHp}` : `远⬜`;
    const near = l.near && l.near.hp > 0 ? `近🌾${l.near.hp}/${l.near.maxHp}` : `近⬜`;
    h += `<div class="lane">路${i+1}: ← ${far} ╋ ${near} → ⚔</div>`;
  });
  return h + '</div>';
}

function buildCard(p, snap, isMe) {
  const card = document.createElement('div');
  card.className = 'pcard' + (p.dead ? ' dead' : '');
  card.dataset.pid = p.id;

  let badges = '';
  if (p.anaesthetized > 0) badges += `<span class="badge ana">💉麻${p.anaesthetized}</span>`;
  if (p.arrested) badges += `<span class="badge arr">🚔</span>`;
  if (p.charge > 0) badges += `<span class="badge chg">⚡${p.charge}</span>`;
  if (p.dead) badges += `<span class="badge deadb">💀</span>`;
  else if (p.isBot) badges += `<span class="badge botb">🤖</span>`;
  else if (!p.online) badges += `<span class="badge offb">📡</span>`;
  let sa = '';
  if (S.sandbox && S.awaitingAction) {
    if (p.id === S.activeActor) sa += `<span class="badge act">🎯</span>`;
    const a = S.sandboxActions[p.id];
    if (a && a.type) {
      const lbl = { attack:'⚔', charge:'⚡', build:'🔨', skill:'✨', pass:'⏭' }[a.type] || a.type;
      sa += `<span class="badge sa">${lbl}${a.target != null ? '→'+(snap.players.find(x=>x.id===a.target)?.name||'') : ''}</span>`;
    }
    if (S.followupTarget != null && a && a.type === 'attack') sa += `<span class="badge ft">追→${snap.players.find(x=>x.id===S.followupTarget)?.name||''}</span>`;
  }
  const hpPct = Math.max(0, (p.hp / p.maxHp) * 100);
  const hpColor = hpPct > 60 ? '#38b878' : (hpPct > 30 ? '#e8a000' : '#e03030');

  // 工事图形
  let fortHtml = '';
  if (p.lanes && p.lanes.length) {
    fortHtml = lanesGraphic(p.lanes);
  } else {
    fortHtml = fortGraphic(p.fortFar, p.fortNear);
  }

  // 资源
  let resHtml = '';
  if (p.resources && Object.keys(p.resources).length) {
    for (const [k, v] of Object.entries<any>(p.resources)) if (v > 0) resHtml += `<span class="res-icon">🔩${k} ${v}</span>`;
    if (resHtml) resHtml = `<div class="resources">${resHtml}</div>`;
  }

  card.innerHTML = `
    <div class="pcard-header"><span class="pname">${p.name}</span>${badges}</div>
    <div class="bar hp${isMe?' me-hp':''}"><i style="width:${hpPct}%;background:${hpColor}"></i></div>
    <div class="hp-text">HP ${p.hp}/${p.maxHp}</div>
    ${fortHtml}
    ${resHtml}
    <div class="pdata">${p.wins>0?'🏆'+p.wins:''}</div>
    <div class="badges">${sa}</div>
  `;
  card.onclick = () => cardClick(p);
  return card;
}

function updateTargetHighlight() {
  [...$('board').children].forEach((c) => c.classList.remove('sel', 'targetable'));
  if (!S.awaitingAction) return;
  const alive = (S.snapshot?.players || []).filter((p) => !p.dead);
  [...$('board').children].forEach((c) => {
    const pid = parseInt(c.dataset.pid);
    if (S.sandbox) {
      if (alive.some((p) => p.id === pid) && pid !== S.activeActor) c.classList.add('targetable');
      if (pid === S.activeActor) c.classList.add('active-actor');
      const a = S.sandboxActions[S.activeActor];
      if (a && a.target === pid) c.classList.add('sel');
    } else {
      if (alive.some((p) => p.id === pid) && pid !== S.pid) c.classList.add('targetable');
      // 自身的 ally 技能也可选
      const ps = S.pendingSkill;
      if (ps && ps.target === 'ally' && alive.some((p) => p.id === pid)) c.classList.add('targetable');
      if (pid === S.selectedTarget) c.classList.add('sel');
    }
    c.style.cursor = c.classList.contains('targetable') ? 'pointer' : 'default';
  });
}

function cardClick(p) {
  if (!S.awaitingAction || p.dead) return;
  if (S.sandbox) {
    if (p.id === S.activeActor) return;
    const a = S.sandboxActions[S.activeActor] || {};
    if (['attack', 'skill', undefined].includes(a.type)) {
      if (!a.type) a.type = 'attack';
      a.target = p.id; S.sandboxActions[S.activeActor] = a;
      renderSandboxPanel(S.snapshot);
      toast(`🎯 ${p.name}`, 600);
    }
    return;
  }
  if (p.id === S.pid) {
    const ps = S.pendingSkill;
    if (ps && ps.target === 'ally') { S.selectedTarget = p.id; updateTargetHighlight(); updateTargetText(); toast(`🎯 ${p.name}(自身)`, 600); return; }
    return;
  }
  S.selectedTarget = p.id; updateTargetHighlight(); updateTargetText(); toast(`🎯 ${p.name}`, 600);
}

function startCountdown(seconds, label, onTimeout) {
  clearInterval(S.countdownTimer);
  const fill = $('timerFill'); const lab = $('timerLabel');
  show('timerWrap'); lab.textContent = label;
  let remain = seconds; const total = seconds;
  fill.style.width = '100%';
  const tick = () => { remain = Math.max(0, remain - 0.1); fill.style.width = (remain/total*100)+'%'; if (remain <= 0) { clearInterval(S.countdownTimer); S.countdownTimer = null; hide('timerWrap'); if (onTimeout) onTimeout(); } };
  tick(); S.countdownTimer = setInterval(tick, 100);
}
function stopCountdown() { clearInterval(S.countdownTimer); S.countdownTimer = null; hide('timerWrap'); }

function onRoundStart(d) { if (S.sandbox) return; S.round = {turn:d.turn,throws:{},results:{},winners:[]}; renderRoundBanner(); promptThrow(); startCountdown(Math.max(1,(d.deadline-Date.now())/1000),'出拳',()=>toast('时间到')); }
function onRoundResult(d) { S.round = {turn:d.turn,throws:d.throws||{},results:d.results||{},winners:d.winners||[]}; S.eventHints = d.events || null; renderRoundBanner(); renderEventBanner(); if(S.snapshot) renderBoard(S.snapshot); }
function onActionPhase(d) {
  S.winners = d.winners || [];
  if (S.snapshot) { S.snapshot = d.snapshot; applySnapshot(d.snapshot); }
  if (S.sandbox) { promptSandboxActions(d.winners, S.snapshot); return; }
  if (S.winners.includes(S.pid)) { promptAction(); startCountdown(15,'行动',()=>toast('时间到，已AI托管')); }
  else promptWait();
}
function promptThrow() {
  S.awaitingThrow = true; S.awaitingAction = false; S.pendingSkill = null;
  hide('actionPanel'); hide('waitPanel'); hide('sandboxPanel'); show('throwPanel');
  const box = $('throwBtns'); box.innerHTML = '';
  S.elements.forEach((el) => {
    const b = document.createElement('button'); b.textContent = el;
    b.onclick = () => { S.socket.emit('submitThrow',{token:S.token,roomId:S.roomId,element:el}); S.awaitingThrow = false; hide('throwPanel'); stopCountdown(); toast('已出拳',1200); };
    box.appendChild(b);
  });
}

// ===== 普通模式行动 =====
// 行动互斥锁定：第一次操作后禁用其他按钮
function lockAction(type) {
  if (S.chosenActionType && S.chosenActionType !== type) return false;
  S.chosenActionType = type;
  // 禁用其他按钮
  [...$('actionBtns').children].forEach((b) => {
    if (b.dataset.actionType && b.dataset.actionType !== type) b.disabled = true;
  });
  return true;
}

// ---- 共享行动渲染层：普通模式与沙盒模式共用，消灭"两处同步"重复 ----
// 单一数据源：根据英雄返回声明式动作列表（攻击/蓄力/建造/技能/跳过）
function buildActionSchema(heroId: string) { return _buildActionSchema(heroId, S.heroes); }
// 唯一按钮渲染函数：两模式都调它，差异只在 onAction（普通立即提交 / 沙盒记入 sandboxActions）
function renderActionButtons(container, schema, onAction) {
  container.innerHTML = '';
  for (const d of schema) {
    const b = document.createElement('button');
    b.textContent = d.label;
    b.dataset.actionType = d.actionType;
    if (d.ghost) b.className = 'ghost';
    b.onclick = () => onAction(d);
    container.appendChild(b);
  }
}

function promptAction() {
  // 自愈：英雄元数据没到位时先拉取再重渲染，避免只剩攻击/蓄力的残缺面板
  if (!S.heroes || S.heroes.length === 0) {
    S.socket.emit('listHeroes', (meta) => { S.heroes = meta || []; promptAction(); });
    return;
  }
  S.awaitingAction = true; S.awaitingThrow = false; S.pendingSkill = null;
  S.chosenActionType = null;
  if (heroUi) heroUi.callAll('resetRound'); // 各英雄插件清理回合状态
  hide('throwPanel'); hide('waitPanel'); hide('sandboxPanel'); show('actionPanel');
  const enemies = (S.snapshot?.players || []).filter((x) => !x.dead && x.id !== S.pid);
  if (!S.selectedTarget || !enemies.some((e) => e.id === S.selectedTarget)) S.selectedTarget = enemies[0]?.id ?? null;
  renderBoard(S.snapshot); updateTargetHighlight(); updateTargetText();
  // 每次行动时都从 snapshot 恢复 myHeroId（确保硬刷新后技能/建造按钮还在）
  S.myHeroId = (S.snapshot?.players.find((p) => p.id === S.pid)?.heroId) || S.myHeroId;

  const ctx = { mode: 'normal', snap: S.snapshot, container: $('actionBtns'), alive: enemies };
  // 行动互斥锁定 + 提交，由共享渲染层 renderActionButtons 统一触发
  const onAction = (d) => {
    if (!lockAction(d.actionType)) return toast('本回合已选择其他行动');
    if (d.key === 'attack') {
      const t = S.selectedTarget || enemies[0]?.id;
      if (t == null) return toast('无可选目标');
      // 插件攻击接管（如剑客追加对话框）
      if (heroUi && heroUi.call(S.myHeroId, 'onAttackButton', t, enemies, ctx)) return;
      submitAction({ type:'attack', target: t });
    } else if (d.key === 'charge') {
      submitAction({ type:'charge' });
    } else if (d.key === 'build') {
      submitAction({ type:'build' });
    } else if (d.key === 'skill') {
      // 插件技能接管（如矿工下井点工事）
      if (heroUi && heroUi.call(S.myHeroId, 'onSkillButton', d, ctx)) return;
      if (d.target === 'none') { submitAction({ type:'skill', skillId:d.skillId }); return; }
      const t = S.selectedTarget || enemies[0]?.id;
      if (t == null) return toast('请先点选目标');
      submitAction({ type:'skill', skillId:d.skillId, target: t });
    } else if (d.key === 'pass') {
      submitAction({ type:'pass' });
    }
  };
  renderActionButtons($('actionBtns'), buildActionSchema(S.myHeroId), onAction);
  // 插件专属状态区/附加控件（如矿工矿石状态+完成按钮）
  if (heroUi) heroUi.callAll('panelRendered', S.myHeroId, ctx);

  S.followupTarget = null;
}

function updateTargetText() {
  const t = (S.snapshot?.players||[]).find((p)=>p.id===S.selectedTarget);
  $('targetText').textContent = t ? `🎯 ${t.name}` : (S.pendingSkill?.target === 'ally' ? '👤点自身或卡牌' : '👆点对方卡牌');
}
const ACTION_LABEL = { attack:'⚔', charge:'⚡', build:'🔨', skill:'✨', pass:'⏭' };

function sandboxAlive(snap) { return (snap?.players||[]).filter((p)=>!p.dead); }

function promptSandboxActions(winners, snap) {
  // 自愈：英雄元数据没到位时先拉取再重渲染
  if (!S.heroes || S.heroes.length === 0) {
    S.socket.emit('listHeroes', (meta) => { S.heroes = meta || []; promptSandboxActions(winners, snap); });
    return;
  }
  S.awaitingAction = true; S.awaitingThrow = false; S.sandboxActions = {}; S.pendingSkill = null; S.followupTarget = null;
  if (heroUi) heroUi.callAll('resetRound'); // 各英雄插件清理回合状态
  // 保留之前选中的英雄，不自动切回第一个
  const prevActive = S.activeActor;
  const alive = sandboxAlive(snap);
  if (prevActive != null && alive.some((p) => p.id === prevActive)) {
    S.activeActor = prevActive; // 保持用户上次选的
  } else {
    S.activeActor = alive[0]?.id ?? null;
    S.actorLocked = false;
  }
  hide('throwPanel'); hide('waitPanel'); hide('actionPanel'); show('sandboxPanel');
  $('btnApplySandbox').onclick = onSandboxApplyClick;
  renderSandboxPanel(snap);
}

function renderSandboxPanel(snap) {
  const alive = sandboxAlive(snap);
  // 用户手动切英雄后锁定，不再自动 reset（除非当前英雄已出局）
  if (!S.actorLocked || S.activeActor == null || !alive.some((p) => p.id === S.activeActor)) {
    S.activeActor = alive[0]?.id ?? null;
  }
  const actors = $('sandboxActors'); actors.innerHTML = '';
  alive.forEach((p) => {
    const c = document.createElement('div');
    c.className = 'achip' + (p.id === S.activeActor ? ' sel' : '');
    c.textContent = p.name;
    c.onclick = () => { S.activeActor = p.id; S.actorLocked = true; renderSandboxPanel(S.snapshot); toast(`🎮 ${p.name}`, 600); };
    actors.appendChild(c);
  });
  const activeHeroId = snap?.players.find((p) => p.id === S.activeActor)?.heroId;
  const ctx = { mode: 'sandbox', snap, container: $('sandboxBtns'), alive };
  // 沙盒：点击只记入 sandboxActions，结算时统一提交（与普通模式共用同一套按钮渲染）
  const onAction = (d) => {
    if (d.key === 'attack') sandboxSetAction('attack');
    else if (d.key === 'charge') sandboxSetAction('charge');
    else if (d.key === 'build') sandboxSetAction('build');
    else if (d.key === 'skill') {
      // 插件技能接管（如矿工下井点工事）
      if (heroUi && heroUi.call(activeHeroId, 'onSkillButton', d, ctx)) return;
      if (d.target === 'none') { sandboxSetAction('skill', d.skillId); return; }
      sandboxSetAction('skill', d.skillId, S.activeActor);
    } else if (d.key === 'pass') sandboxSetAction('pass');
  };
  renderActionButtons($('sandboxBtns'), buildActionSchema(activeHeroId), onAction);
  // 插件专属状态区/附加控件（如矿工矿石状态、剑客追加目标下拉）
  if (heroUi) heroUi.callAll('panelRendered', activeHeroId, ctx);
  if (S.snapshot) renderBoard(S.snapshot);
  updateTargetHighlight();
}

function sandboxSetAction(type, skillId?, target?) {
  const pid = S.activeActor;
  if (pid == null) return toast('请先选操控的英雄');
  const alive = sandboxAlive(S.snapshot);
  const enemies = alive.filter((e) => e.id !== pid);
  const a = S.sandboxActions[pid] || {};
  a.type = type;
  if (type === 'attack' || type === 'skill') {
    a.target = (target != null) ? target : (a.target ?? enemies[0]?.id);
    if (type === 'skill') a.skillId = skillId || skillNamesMeta(S.snapshot.players.find((p)=>p.id===pid)?.heroId)[0];
    if (heroUi) heroUi.call(heroIdOf(pid), 'transformSandboxAction', a, type); // 插件改写（如剑客塞 sub.ft）
  } else { delete a.target; delete a.skillId; delete a.sub; }
  S.sandboxActions[pid] = a;
  renderSandboxPanel(S.snapshot);
  toast(`✅ ${S.snapshot?.players.find((p)=>p.id===pid)?.name||''} → ${ACTION_LABEL[type]||type}`, 600);
}
function heroIdOf(pid) { return S.snapshot?.players.find((p)=>p.id===pid)?.heroId; }

function onSandboxApplyClick() {
  const snap = S.snapshot; if (!snap) return;
  const alive = sandboxAlive(snap);
  alive.forEach((p) => {
    let a = S.sandboxActions[p.id] || { type:'pass' };
    const enemies = alive.filter((e) => e.id !== p.id);
    if (a.type === 'attack' || a.type === 'skill') {
      // 对 target:'none' 的技能（如下井）不设置目标
      if (a.type === 'skill') {
        const tgt = skillTargetMeta(p.heroId, a.skillId);
        if (tgt === 'none') { delete a.target; } // 保持 target 为空
        else {
          if (a.target == null || !alive.some((e) => e.id === a.target)) a.target = enemies[0]?.id;
          if (a.target == null) a = { type:'pass' };
        }
      } else {
        if (a.target == null || !alive.some((e) => e.id === a.target)) a.target = enemies[0]?.id;
        if (a.target == null) a = { type:'pass' };
      }
      if (a.type === 'skill' && !a.skillId) a.skillId = skillNamesMeta(p.heroId)[0];
    }
    S.socket.emit('submitAction', { token:S.token, roomId:S.roomId, action:a, playerId:p.id });
  });
  S.awaitingAction = false; hide('sandboxPanel'); stopCountdown(); S.followupTarget = null;
  if (heroUi) heroUi.callAll('resetRound');
  toast('✅ 已结算', 1200);
}

function promptWait() {
  S.awaitingAction = false; S.awaitingThrow = false; S.pendingSkill = null;
  hide('throwPanel'); hide('actionPanel'); hide('sandboxPanel'); show('waitPanel');
  $('waitTitle').textContent = S.round.results[S.pid] === 'lose' ? '💔 输了，等待结算...' : '⏳ 等待其他玩家...';
}

function submitAction(action) {
  if (action.target == null && (action.type === 'attack' || (action.type === 'skill' && skillTargetMeta(S.myHeroId, action.skillId) !== 'none' && skillTargetMeta(S.myHeroId, action.skillId) !== 'ally'))) {
    return toast('请先选择目标');
  }
  S.socket.emit('submitAction', { token:S.token, roomId:S.roomId, action });
  S.awaitingAction = false; hide('actionPanel'); stopCountdown();
  S.selectedTarget = null; S.followupTarget = null;
  if (heroUi) heroUi.callAll('resetRound');
  toast('✅ 已提交', 1000);
}

function onMemberStatus(d) {
  if (!S.snapshot) return;
  const p = S.snapshot.players.find((x) => x.id === d.pid);
  if (p) { p.online = d.online; renderBoard(S.snapshot); }
}

function pushLog(lines) {
  lines.forEach((l) => S.logLines.push(l));
  if (S.logLines.length > 80) S.logLines = S.logLines.slice(-80);
  $('logBox').innerHTML = S.logLines.map((l) => `<div>· ${l}</div>`).join('');
  $('logBox').scrollTop = $('logBox').scrollHeight;
}
// 日志开关
$('btnToggleLog').onclick = () => { $('logBox').classList.toggle('hidden'); };

$('btnPause').onclick = () => { if (S.roomId && S.token) S.socket.emit('pause', { token:S.token, roomId:S.roomId }); };
$('btnResume').onclick = () => { if (S.roomId && S.token) S.socket.emit('resume', { token:S.token, roomId:S.roomId }); };

function showGameOver(d) {
  S.gameOver = true;
  const snap = d.snapshot;
  let winnerName = '平局';
  if (d.winner != null && snap) {
    const w = snap.players.find((p) => p.id === d.winner);
    winnerName = w ? w.name + (w.id === S.pid ? '（你）' : '') : '未知';
  }
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal-box"><div class="big win">🏆 ${winnerName} 获胜！</div><button id="btnBackLobbyGO" class="primary">返回大厅</button></div>`;
  document.body.appendChild(ov);
  $('btnBackLobbyGO').onclick = () => { ov.remove(); goHome(); };
}

function resetToLobby() {
  clearInterval(S.countdownTimer); S.countdownTimer = null;
  S.snapshot = null; S.gameOver = false; S.round = { turn:0, throws:{}, results:{}, winners:[] };
  S.awaitingThrow = S.awaitingAction = false; S.selectedTarget = null; S.paused = false;
  S.sandboxActions = {}; S.activeActor = null; S.pendingSkill = null; S.followupTarget = null; S.actorLocked = false;
  if (heroUi) heroUi.callAll('resetRound');
  S.roomId = null; S.token = null; S.joined = false; S.members = [];
  clearRoom(); hide('game'); hide('room'); hide('pauseOverlay'); hide('btnBackRoom'); show('lobby');
}

// 暴露运行时 API 给英雄插件（miner-ui/swordsman-ui 通过 import { appCtx } 使用）。
// 放在模块末尾：此时所有函数声明已 hoist、S/$ 等 const 已初始化。
export const appCtx = {
  S,
  $,
  toast,
  show,
  hide,
  submitAction,
  renderBoard,
  applySnapshot,
  promptAction,
  promptSandboxActions,
  saveRoom,
  clearRoom,
  startCountdown,
  stopCountdown,
  renderEventBanner,
  enterGame,
  resetToLobby,
};

(function init() {
  connect();
})();
