const T = (k, v) => globalThis.TE_I18N.T(k, v);
const $ = (id) => document.getElementById(id);
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const EXT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>';
const LOG_ROWS = 8;
let logOpen = false;
const COPY_BTN = (attrs) => `<button class="cp" title="${T('복사')}" aria-label="${T('복사')}" ${attrs}>${COPY_ICON}</button>`;
// every copy button: data-copy="text" or data-copy-el="<element id>"
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.cp');
  if (!b) return;
  const text = b.dataset.copy != null ? b.dataset.copy : ($(b.dataset.copyEl) || {}).textContent || '';
  if (!text) return;
  await navigator.clipboard.writeText(text);
  b.classList.add('done'); b.innerHTML = CHECK_ICON;
  setTimeout(() => { b.classList.remove('done'); b.innerHTML = COPY_ICON; }, 1200);
});
const send = (msg) => chrome.runtime.sendMessage(msg);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const say = (id, text, cls = 'mut') => { $(id).className = 'msg ' + cls; $(id).textContent = text || ''; };
const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');
const fmtPrice = (n) => {
  if (n == null || !Number.isFinite(n) || n <= 0) return '-';
  if (n >= 0.001) return n.toPrecision(4);
  const z = Math.floor(-Math.log10(n)); // zeros right after the decimal point
  const digits = Math.round(n * 10 ** (z + 3)).toString().slice(0, 3);
  return '0.0' + String(z).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[d]).join('') + digits;
};
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? T('{n}초 전', { n: s }) : T('{n}분 전', { n: Math.round(s / 60) }); };

let W = null, C = null, OB = null, tab = 'home', liveAsk = false;
const VIEWS = ['vOnboard', 'vLockSetup', 'vBackup', 'vHelius', 'vLocked', 'vHome', 'vSettings', 'vSend'];
const OB_VIEW = { backup: 'vBackup', lock: 'vLockSetup', helius: 'vHelius' };
// view-enter direction: going deeper slides in from the right, going back from the left
const DEPTH = { vOnboard: 0, vBackup: 1, vLockSetup: 2, vHelius: 3, vLocked: 3, vHome: 4, vSettings: 5, vSend: 5 };
let curView = null;

async function load() {
  [W, C] = await Promise.all([send({ type: 'wallet:status' }), send({ type: 'config:get' })]);
  let { onboard = null, backupAck } = await chrome.storage.local.get(['onboard', 'backupAck']);
  if (!onboard && backupAck === false) onboard = { step: 'backup', created: true }; // v0.10.2 and older
  if (!W.exists) onboard = null;
  OB = onboard;
}
const setOnboard = async (ob) => { OB = ob; if (ob) await chrome.storage.local.set({ onboard: ob, backupAck: true }); else await chrome.storage.local.remove(['onboard', 'backupAck']); };

function renderStepper() {
  const steps = OB && OB.created === false ? ['wallet', 'lock', 'helius'] : ['wallet', 'backup', 'lock', 'helius'];
  const names = { wallet: T('지갑'), backup: T('백업'), lock: T('잠금'), helius: 'Helius' };
  document.querySelectorAll('.stepper').forEach((el) => {
    const i = steps.indexOf(el.dataset.of);
    el.setAttribute('aria-label', `${i + 1}/${steps.length} ${names[el.dataset.of]}`);
    el.innerHTML = steps.map((_, j) => `<i class="${j === i ? 'cur' : j < i ? 'done' : ''}"></i>`).join('');
  });
}

function view() {
  let v;
  if (!W.exists) v = 'vOnboard';
  else if (OB && !(W.encrypted && !W.unlocked)) v = OB_VIEW[OB.step] || 'vHome';
  else if (tab === 'settings') v = 'vSettings';
  else if (tab === 'send' && W.unlocked) v = 'vSend';
  else if (!W.unlocked) v = 'vLocked';
  else v = 'vHome';
  const changed = v !== curView;
  if (curView && changed) document.body.dataset.dir = DEPTH[v] < DEPTH[curView] ? 'back' : 'fwd'; // first paint: no animation
  curView = v;
  VIEWS.forEach((x) => show(x, x === v));
  if (changed) $(v).scrollTop = 0;
  const inSettings = v === 'vSettings' || v === 'vSend', setup = v === 'vOnboard' || !!OB_VIEW_REV[v];
  show('hHome', !inSettings); show('hSettings', inSettings);
  $('hTitle').textContent = v === 'vSend' ? T('SOL 출금') : T('설정');
  show('modeSeg', !inSettings && !setup && v !== 'vLocked');
  show('btnGear', !inSettings && !setup);
  show('btnObBack', setup && !!obPrev());
  show('langMini', setup || v === 'vLocked'); // settings are not reachable here: language toggle in the header
  show('siteStatus', !inSettings && !setup);
  show('liveConfirm', liveAsk && !inSettings && !setup);
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === C.mode));
  if (setup) renderStepper();
  return v;
}
const OB_VIEW_REV = { vBackup: 1, vLockSetup: 1, vHelius: 1 };

// ---------- header: mode ----------
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', async () => {
  if (b.dataset.mode === C.mode) return;
  if (b.dataset.mode === 'live') { liveAsk = true; $('lcMax').textContent = C.maxSolPerTrade; view(); return; }
  C = await send({ type: 'config:set', patch: { mode: 'simulate' } }); liveAsk = false; view();
}));
$('lcYes').onclick = async () => { C = await send({ type: 'config:set', patch: { mode: 'live' } }); liveAsk = false; view(); };
$('lcNo').onclick = () => { liveAsk = false; view(); };
$('liveConfirm').addEventListener('click', (e) => { if (e.target === $('liveConfirm')) $('lcNo').click(); }); // backdrop
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && liveAsk) $('lcNo').click(); });

// ---------- current terminal (status only, not clickable) ----------
const SITES = { axiom: { re: /(^|\.)axiom\.trade$/, name: 'Axiom', url: 'https://axiom.trade', ok: true },
  gmgn: { re: /(^|\.)gmgn\.ai$/, name: 'GMGN', url: 'https://gmgn.ai', ok: true },
  padre: { re: /(^|\.)padre\.gg$/, name: 'Padre', url: 'https://trade.padre.gg', ok: false } };
async function renderSite() {
  let host = '';
  try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); host = t && t.url ? new URL(t.url).hostname : ''; } catch (_) {}
  const [key, cur] = Object.entries(SITES).find(([, s]) => s.re.test(host)) || [null, null];
  const on = !!(cur && cur.ok);
  $('siteStatus').classList.toggle('on', on);
  if (cur) { $('siteIcon').src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(cur.url)}&size=32`); show('siteIcon', true); }
  else show('siteIcon', false);
  const teKey = on ? 'teMode_' + key : null; // supported sites: the terminal's own buttons are executed by Tradeasy
  show('teSwitchWrap', !!teKey);
  if (teKey) { const { [teKey]: m } = await chrome.storage.local.get(teKey); $('teSwitch').checked = m !== false; $('teSwitch').dataset.key = teKey; }
  $('siteText').textContent = !cur ? T('지원 사이트가 아닙니다') : cur.ok ? T('{site}에서 동작 중', { site: cur.name }) : T('{site}는 아직 지원하지 않습니다', { site: cur.name });
}

$('teSwitch').addEventListener('change', () => chrome.storage.local.set({ [$('teSwitch').dataset.key]: $('teSwitch').checked }));

// ---------- onboarding: back ----------
// previous step; going back to the wallet step removes the wallet made or imported in this onboarding
function obPrev() {
  if (!OB) return null;
  if (OB.step === 'helius') return W.encrypted ? null : 'lock'; // lock already set: nothing to redo
  if (OB.step === 'lock') return OB.created ? 'backup' : 'wallet';
  if (OB.step === 'backup') return 'wallet';
  return null;
}
$('btnObBack').onclick = async () => {
  const prev = obPrev();
  if (!prev) return;
  if (prev !== 'wallet') { await setOnboard({ ...OB, step: prev }); return refresh(); }
  const created = OB.created !== false;
  const { ok } = await dialog({
    title: T('처음으로 돌아갈까요?'),
    body: created
      ? T('<div class="warnbox">방금 만든 지갑을 지웁니다. 백업한 key가 있다면 나중에 가져오기로 다시 쓸 수 있습니다.</div>')
      : T('<div class="small">가져온 지갑을 이 확장프로그램에서 지웁니다. 지갑 자체는 그대로입니다.</div>'),
    yes: T('처음으로'), tone: created ? 'danger' : 'primary',
  });
  if (!ok) return;
  const b = await send({ type: 'wallet:balance' }).catch(() => null);
  if (b && b.sol > 0) return dialog({ title: T('지우지 않았습니다'), body: `<div class="small">${T('이 지갑에 SOL이 있어 지우지 않았습니다. 설정을 마친 뒤 출금하세요.')}</div>` });
  await send({ type: 'wallet:remove' });
  await setOnboard(null);
  await refresh();
};

// ---------- onboarding: 1 wallet ----------
$('chCreate').onclick = async () => {
  const r = await send({ type: 'wallet:create' });
  if (r.error) return say('oMsg', r.error, 'bad');
  await setOnboard({ step: 'backup', created: true });
  await refresh();
};
$('chImport').onclick = () => { show('importBox', true); $('importSk').focus(); };
$('btnImportCancel').onclick = () => { show('importBox', false); $('importSk').value = ''; };
$('btnImport').onclick = async () => {
  const secret = $('importSk').value.trim();
  if (!secret) return say('oMsg', T('Private Key를 붙여넣어 주세요'), 'warn');
  const r = await send({ type: 'wallet:create', secret });
  $('importSk').value = '';
  if (r.error) return say('oMsg', r.error, 'bad');
  await setOnboard({ step: 'lock', created: false });
  await refresh();
};

// ---------- onboarding: 2 backup (new wallets) ----------
async function renderBackup() {
  if ($('backupKey').textContent) return;
  const k = await send({ type: 'wallet:reveal' });
  $('backupKey').textContent = k.secret || '';
}
$('backupChk').onchange = () => { $('btnBackupDone').disabled = !$('backupChk').checked; };
$('btnBackupDone').onclick = async () => { $('backupKey').textContent = ''; await setOnboard({ ...OB, step: 'lock' }); await refresh(); };

// ---------- onboarding: 3 extension lock (optional) ----------
$('btnLockSet').onclick = async () => {
  const pw = $('lsPw').value, pw2 = $('lsPw2').value;
  if (pw.length < 8) return say('lsMsg', T('8자 이상 입력하세요'), 'warn');
  if (pw !== pw2) return say('lsMsg', T('비밀번호 확인이 일치하지 않습니다'), 'warn');
  const r = await send({ type: 'wallet:setPassword', oldPassword: null, newPassword: pw });
  if (r.error) return say('lsMsg', r.error, 'bad');
  $('lsPw').value = ''; $('lsPw2').value = ''; say('lsMsg', '');
  await setOnboard({ ...OB, step: 'helius' }); await refresh();
};
$('lsPw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnLockSet').click(); });
$('btnLockSkip').onclick = async () => { await setOnboard({ ...OB, step: 'helius' }); await refresh(); };

// ---------- onboarding: 4 helius ----------
function renderHeliusStep() {
  if (document.activeElement !== $('obKey') && !$('obKey').value) $('obKey').value = C.heliusApiKey || '';
  if (C.heliusApiKey && !$('obKeyStat').textContent) connectKey('obKey', 'obKeyStat');
}
$('btnObDone').onclick = async () => { await setOnboard(null); tab = 'home'; await refresh(); };
$('btnObLater').onclick = $('btnObDone').onclick;

// ---------- Helius key: save + test (onboarding and settings share this) ----------
let keySeq = 0, keyOk = null;
function keyStat(id, cls, text) { $(id).className = 'keystat ' + cls; $(id).textContent = text; }
async function connectKey(inputId, statId) {
  const seq = ++keySeq;
  const v = $(inputId).value.trim();
  keyStat(statId, 'busy', v ? T('연결 확인 중...') : '');
  const r = await send({ type: 'config:set', patch: { heliusApiKey: v } });
  if (seq !== keySeq) return;
  if (r.error) { keyOk = false; keyStat(statId, 'bad', r.error === 'invalid Helius API key' ? T('API key 형식이 올바르지 않습니다') : r.error); return syncKeyUi(); }
  C = r;
  if (!v && !C.customRpcUrl) { keyOk = null; keyStat(statId, '', ''); return syncKeyUi(); }
  const t = await send({ type: 'config:test' });
  if (seq !== keySeq) return;
  keyOk = !!t.ok;
  keyStat(statId, t.ok ? 'ok' : 'bad', t.ok ? T('연결됨 · 저장 완료 ({ms}ms)', { ms: t.ms }) : T('연결 안 됨: {err}', { err: t.error }));
  syncKeyUi();
}
function syncKeyUi() {
  $('btnObDone').disabled = !keyOk;
  document.querySelectorAll('.hlink').forEach((a) => a.classList.toggle('hidden', !!keyOk)); // only needed until a key works
}
function bindKeyInput(inputId, btnId, statId) {
  let timer = null;
  const go = () => { clearTimeout(timer); connectKey(inputId, statId); };
  $(inputId).addEventListener('input', () => { clearTimeout(timer); keyStat(statId, 'busy', T('입력 중...')); timer = setTimeout(go, 700); });
  $(inputId).addEventListener('paste', () => setTimeout(go, 0));
  $(inputId).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $(btnId).onclick = go;
}
bindKeyInput('obKey', 'btnObConnect', 'obKeyStat');
bindKeyInput('heliusApiKey', 'btnConnect', 'keyStat');

// ---------- locked ----------
$('btnUnlock').onclick = async () => {
  const r = await send({ type: 'wallet:unlock', password: $('unlockPw').value });
  $('unlockPw').value = '';
  if (r.error) return say('lMsg', r.error === 'wrong password' ? T('비밀번호가 틀렸습니다') : r.error, 'bad');
  await refresh();
};
$('unlockPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnUnlock').click(); });

// ---------- navigation: gear -> settings, back -> home ----------
$('btnGear').onclick = () => { tab = 'settings'; liveAsk = false; renderAll(); };
$('btnBack').onclick = () => { tab = 'home'; renderAll(); };
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.goto; renderAll(); }));

// ---------- home ----------
let lastSol = null, anyTrade = false;
async function renderHome() {
  $('addrShort').textContent = W.pubkey ? W.pubkey.slice(0, 5) + '…' + W.pubkey.slice(-5) : '';
  $('addrFull').textContent = W.pubkey || '';
  $('lockedAddr').textContent = W.pubkey || '';
  $('lockPill').textContent = W.encrypted ? T('잠금 켜짐') : T('잠금 꺼짐');
  const hasKey = !!(C.heliusApiKey || C.customRpcUrl);
  let balErr = null;
  if (hasKey) {
    const b = await send({ type: 'wallet:balance' });
    balErr = b && b.error ? b.error : null;
    lastSol = b && typeof b.sol === 'number' ? b.sol : null;
    $('bal').innerHTML = lastSol == null ? `- <small>SOL</small>` : `${lastSol.toFixed(4)} <small>SOL</small>`;
  } else $('bal').innerHTML = `- <small>SOL</small>`;
  const keyDone = hasKey && !balErr;
  $('tdKeyText').textContent = keyDone ? T('Helius 연결됨') : hasKey ? T('Helius 연결 실패') : T('Helius 연결');
  if (hasKey && !keyDone) { $('tdKeySub').textContent = T('API key를 확인하세요'); $('tdKeySub').className = 'bad small'; }
  else { $('tdKeySub').textContent = ''; $('tdKeySub').className = 'small'; }
  show('tdKeyGo', !keyDone);

  const trades = await send({ type: 'trades:get' });
  anyTrade = Array.isArray(trades) && trades.length > 0;
  const done = { Key: keyDone, Fund: lastSol > 0, Sim: anyTrade };
  for (const [id, ok] of Object.entries(done)) {
    $('td' + id).classList.toggle('done', ok); $('td' + id).textContent = ok ? '✓' : { Key: 1, Fund: 2, Sim: 3 }[id];
    $('st' + id).classList.toggle('done', ok);
  }
  const n = Object.values(done).filter(Boolean).length;
  $('todoHead').textContent = T('시작 체크리스트 {n}/3', { n });
  show('todo', n < 3);

  const list = await send({ type: 'watch:get' });
  let activeTab = null;
  try { [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (_) {}
  const w = Array.isArray(list) && (list.find((x) => activeTab && x.tabId === activeTab.id) || null);
  const POOL = { pump: 'pump.fun', pumpswap: 'PumpSwap', meteora_dbc: 'Meteora DBC', meteora_damm_v2: 'Meteora DAMM v2', raydium_launchlab: 'Raydium LaunchLab', raydium_cpmm: 'Raydium CPMM', jupiter: T('Jupiter 경유') };
  const onTokenPage = activeTab && activeTab.url && /^https:\/\/(?:[\w-]+\.)?(?:axiom\.trade\/(?:token|meme)|gmgn\.ai\/sol\/token)\//.test(activeTab.url);
  const tokState = (text, cls = '') => { $('tokState').textContent = text || ''; $('tokState').className = 'pill ' + cls; show('tokState', !!text); };
  if (!w && onTokenPage) {
    tokState(T('연결 안 됨'), 'warnpill');
    $('tokBody').innerHTML = T('<div class="small mut" style="margin-bottom:8px">이 탭은 Tradeasy가 설치(업데이트)되기 전에 열려서 아직 연결되지 않았습니다.</div><button class="btn sm" id="btnReloadTab">탭 새로고침</button>');
    $('btnReloadTab').onclick = () => { chrome.tabs.reload(activeTab.id); $('tokBody').textContent = T('새로고침 중...'); };
  } else if (!w) {
    tokState('');
    $('tokBody').textContent = T('지금 탭에서 Axiom / GMGN 토큰 페이지를 열면 여기에 표시됩니다.');
  } else {
    const s = hasKey ? w.state : null, m = w.meta || {};
    const unsupported = w.error && !s && /unsupported venue|only SOL-/.test(w.error);
    tokState(!hasKey ? T('Helius 연결 필요') : s ? '' : unsupported ? T('미지원') : w.error ? T('오류') : T('불러오는 중'), !hasKey || w.error ? 'warnpill' : '');
    const title = m.name || m.symbol || short(w.mint);
    // letters underneath, image on top: a failed image simply leaves the letters visible
    const img = `<div class="tokimg">${esc((m.symbol || m.name || '?').slice(0, 2).toUpperCase())}${m.image ? `<img src="${esc(m.image)}" alt="" referrerpolicy="no-referrer">` : ''}</div>`;
    let html = `<div class="tok">${img}<div style="min-width:0;flex:1"><div class="tokhead"><span class="tokname">${esc(title)}</span>${m.symbol && m.name ? `<span class="ticker">$${esc(m.symbol)}</span>` : ''}</div>` +
      `<div class="tokaddr"><span>${esc(w.mint.slice(0, 6) + '…' + w.mint.slice(-6))}</span>${COPY_BTN(`data-copy="${esc(w.mint)}"`)}</div></div></div>`;
    if (hasKey && unsupported) html += T('<div class="small mut">Tradeasy가 아직 지원하지 않는 풀입니다 (Raydium AMM v4·CLMM, Meteora DLMM 등). 지원: pump.fun, PumpSwap, Meteora DBC·DAMM v2, Raydium LaunchLab·CPMM</div>');
    else if (hasKey && w.error && !s) html += `<div class="${unsupported ? 'warn' : 'bad'} small">${esc(w.friendly || w.error)}</div>`;
    // main numbers as tiles (holding, PnL), the rest as a key-value list
    const P = w.position, pool = s ? esc(T(POOL[s.venue] || s.venue)) : '';
    const sol = (n) => (n == null ? '-' : n.toFixed(4) + ' SOL');
    const tile = (k, v, cls = '', sub = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${cls}" title="${v}">${v}</div>${sub ? `<div class="s ${cls}">${sub}</div>` : ''}</div>`;
    const tiles = [], kv = [];
    if (s) tiles.push(tile(T('보유'), Number(s.tokenBalance).toLocaleString(undefined, { maximumFractionDigits: 2 }) + (m.symbol ? ' ' + esc(m.symbol) : '')));
    if (P) {
      const cls = P.pnl == null ? '' : P.pnl >= 0 ? 'up' : 'down';
      const sign = P.pnl > 0 ? '+' : '';
      tiles.push(tile(T('손익'), P.pnl == null ? '-' : `${sign}${P.pnl.toFixed(4)} SOL`, cls, P.pnl == null ? '' : `${sign}${P.pnlPct.toFixed(1)}%`));
      if (P.avgPrice) kv.push([T('평균 매수가'), `${fmtPrice(P.avgPrice)} SOL`]);
      kv.push([T('투입'), sol(P.invested)]);
      if (P.returned > 0) kv.push([T('회수'), sol(P.returned)]);
      kv.push([T('지금 팔면'), sol(P.value)]);
      if (s) kv.push([T('풀'), pool]);
    } else if (s) tiles.push(tile(T('풀'), pool));
    if (s) kv.push([T('갱신'), ago(s.at)]);
    if (tiles.length) html += `<div class="tiles">${tiles.join('')}</div>`;
    if (kv.length) html += `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    if (P) html += T('<div class="dim small" style="margin-top:4px">Tradeasy 지갑 LIVE 체결 기준</div>');
    $('tokBody').innerHTML = html;
  }

  if (!anyTrade) { $('log').innerHTML = T('<span class="mut small">아직 없습니다</span>'); return; }
  // one row per trade (older logs stored the confirm as a separate entry: fold it in)
  const confirms = new Map(trades.filter((x) => x.confirm && x.signature).map((x) => [x.signature, x.confirm]));
  const confirmOnly = (x) => x.confirm && trades.some((y) => y !== x && y.signature === x.signature && !y.confirm);
  const all = trades.filter((x) => !confirmOnly(x));
  const rows = logOpen ? all : all.slice(0, LOG_ROWS);
  const fmt = (n) => (n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : n.toLocaleString(undefined, { maximumFractionDigits: 4 }));
  $('log').innerHTML = rows.map((x) => {
    const t = new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const link = (sig, label) => `${label}<a class="sx" target="_blank" title="Solscan" aria-label="Solscan" href="https://solscan.io/tx/${esc(sig)}">${EXT_ICON}</a>`;
    const c = x.confirm || (x.signature ? confirms.get(x.signature) : null);
    const sym = x.symbol || T('토큰');
    let tag, what;
    if (x.side === 'withdraw') { tag = T('<span class="tag wd">출금</span>'); what = `${fmt(x.sol)} SOL → ${esc(short(x.to))}`; }
    else if (x.side === 'close') { tag = T('<span class="tag wd">계정 정리</span>'); what = T('{n}개 · +{sol} SOL', { n: x.count, sol: fmt(x.sol) }); }
    else {
      tag = `<span class="tag ${x.simulated ? 'sim' : 'live'}">${x.simulated ? 'SIM' : 'LIVE'}</span><span class="tag ${x.side === 'sell' ? 'sell' : 'buy'}">${x.side === 'sell' ? T('매도') : T('매수')}</span>`;
      const e = x.expected;
      what = !e ? '' : x.side === 'buy' ? `${e.sol} SOL → ${fmt(e.tokens)} ${esc(sym)}` : `${fmt(e.tokens)} ${esc(sym)} → ${fmt(e.sol)} SOL`;
    }
    let res;
    if (x.side === 'close') res = link(x.signature, x.failed ? T('<span class="bad">일부 실패</span>') : T('<span class="ok">완료</span>'));
    else if (x.simulated) res = x.ok ? T('<span class="ok">성공</span>') : T('<span class="bad">실패</span>');
    else if (c) res = link(x.signature, c.status === 'confirmed' ? T('<span class="ok">체결</span>') : `<span class="bad">${c.status === 'timeout' ? T('확인 안 됨') : T('실패')}</span>`);
    else res = x.signature ? link(x.signature, T('<span class="dim">확인 중</span>')) : '';
    return `<div><span class="row" style="gap:4px;min-width:0">${tag}<span class="small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${what}</span></span><span class="row" style="gap:6px;flex:0 0 auto"><span class="dim small">${t}</span>${res}</span></div>`;
  }).join('') + (all.length > LOG_ROWS ? `<button class="link more" id="logMore">${logOpen ? T('접기') : T('더 보기 ({n})', { n: all.length - LOG_ROWS })}</button>` : '');
  const more = $('logMore'); if (more) more.onclick = () => { logOpen = !logOpen; renderHome(); };
}

// ---------- home: copy / withdraw ----------
let sendMax = false, sendPlan = null;
function sendReset() {
  sendMax = false; sendPlan = null; $('sendTo').value = ''; $('sendAmt').value = ''; say('sendMsg', '');
  show('sendForm', true); show('sendConfirm', false); show('sendDone', false); $('sendForm').inert = false;
  $('sendAvail').textContent = lastSol == null ? '' : T('· 잔고 {sol} SOL', { sol: lastSol.toFixed(4) });
}
$('btnSendOpen').onclick = () => { if (!(C.heliusApiKey || C.customRpcUrl)) { tab = 'settings'; return renderAll(); } tab = 'send'; liveAsk = false; sendReset(); renderAll(); };
$('btnSendMax').onclick = () => { sendMax = true; $('sendAmt').value = lastSol != null ? Math.max(0, lastSol - 0.000025).toFixed(6) : ''; };
$('sendAmt').addEventListener('input', () => { sendMax = false; });
$('btnSendNext').onclick = async () => {
  say('sendMsg', T('확인 중...'));
  const r = await send({ type: 'wallet:sendPlan', to: $('sendTo').value, sol: $('sendAmt').value, max: sendMax });
  if (r.error) return say('sendMsg', r.friendly && !/[가-힣]/.test(r.error) ? r.friendly : r.error, 'bad');
  say('sendMsg', '');
  sendPlan = { to: r.to, sol: r.lamports / 1e9, max: sendMax };
  $('scTo').textContent = r.to;
  $('scAmt').textContent = `${(r.lamports / 1e9).toFixed(6)} SOL`;
  $('scFee').textContent = `${(r.fee / 1e9).toFixed(6)} SOL`;
  $('scLeft').textContent = `${((r.balance - r.lamports - r.fee) / 1e9).toFixed(6)} SOL`;
  $('scNew').textContent = r.newAccount ? T('이 주소는 아직 한 번도 쓰이지 않은 새 주소입니다. 주소를 다시 확인하세요.') : '';
  show('sendConfirm', true); $('sendForm').inert = true; // tray over the form; the form stays visible but inactive
};
$('btnSendBack').onclick = () => { show('sendConfirm', false); $('sendForm').inert = false; };
$('sendConfirm').addEventListener('click', (e) => { if (e.target === $('sendConfirm')) $('btnSendBack').click(); }); // backdrop
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sendConfirm').classList.contains('hidden')) $('btnSendBack').click(); });
$('btnSendGo').onclick = async () => {
  if (!sendPlan) return;
  show('sendConfirm', false); show('sendForm', false); $('sendForm').inert = false; show('sendDone', true);
  $('sdTitle').textContent = T('전송 중...'); $('sdBody').textContent = T('서명하고 보내는 중입니다. 팝업을 닫아도 전송은 계속됩니다.');
  const r = await send({ type: 'wallet:send', to: sendPlan.to, sol: sendPlan.sol, max: sendPlan.max });
  sendPlan = null;
  if (r.error) { $('sdTitle').textContent = T('전송 실패'); $('sdBody').innerHTML = `<span class="bad">${esc(r.friendly || r.error)}</span>`; return; }
  const ok = r.confirm && r.confirm.status === 'confirmed';
  $('sdTitle').textContent = ok ? T('출금 완료') : r.confirm && r.confirm.status === 'failed' ? T('전송 실패') : T('전송됨 (확인 지연)');
  $('sdBody').innerHTML = `${r.sol.toFixed(6)} SOL · <a target="_blank" href="https://solscan.io/tx/${esc(r.signature)}">${T('Solscan에서 보기')}</a>`;
};
$('sendTo').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sendAmt').focus(); });
$('sendAmt').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSendNext').click(); });
$('btnSendClose').onclick = () => { tab = 'home'; refresh(); };

// ---------- settings ----------
const FIELDS = ['customRpcUrl', 'jupiterApiKey', 'maxSolPerTrade', 'cuLimit', 'autoLockMin', 'autoSlippage', 'autoPriorityFeeSol', 'autoTipSol'];
let settingsOpened = false;
function renderSettings() {
  for (const k of FIELDS) if (document.activeElement !== $(k)) $(k).value = C[k] ?? '';
  if (document.activeElement !== $('heliusApiKey')) $('heliusApiKey').value = C.heliusApiKey || '';
  $('ignoreMev').checked = !!C.ignoreMev;
  if (!settingsOpened) {
    settingsOpened = true;
    if (C.heliusApiKey || C.customRpcUrl) connectKey('heliusApiKey', 'keyStat');
    else keyStat('keyStat', 'bad', T('연결 안 됨: API key를 입력하세요'));
    scanAccounts();
  }
  show('secCard', W.exists); show('walCard', W.exists);
  renderLock();
  $('walAddr').textContent = W.pubkey || '';
}
// autosave: no save button. Saved shortly after typing stops, and on blur/toggle.
const flash = (key) => { const el = document.querySelector(`[data-saved="${key}"]`); if (!el) return; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1200); };
async function saveField(k) {
  const patch = k === 'ignoreMev' ? { ignoreMev: $('ignoreMev').checked } : { [k]: $(k).value };
  const r = await send({ type: 'config:set', patch });
  if (r.error) { say('sMsg', r.error, 'bad'); return; }
  C = r; say('sMsg', '');
  flash(/^auto(Slippage|PriorityFeeSol|TipSol)$/.test(k) ? 'auto' : k);
  if (k === 'customRpcUrl') connectKey('heliusApiKey', 'keyStat');
  if (k === 'autoLockMin') renderLock();
}
for (const k of FIELDS) {
  let t = null;
  $(k).addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => saveField(k), 600); });
  $(k).addEventListener('change', () => { clearTimeout(t); saveField(k); });
}
$('ignoreMev').addEventListener('change', () => saveField('ignoreMev'));

const pwErr = (e) => (e === 'wrong password' ? T('비밀번호가 틀렸습니다') : e === 'password too short' ? T('8자 이상 입력하세요') : e);

// extension lock: a toggle. Turning it on/off opens a small inline form; nothing changes until confirmed.
let lockMode = null; // null | 'on' | 'off' | 'change'
function renderLock() {
  const on = W.encrypted;
  $('lockToggle').checked = lockMode === 'on' ? true : lockMode === 'off' ? false : on;
  $('secDesc').textContent = lockMode === 'on' ? T('비밀번호를 정하면 켜집니다')
    : lockMode === 'off' ? T('현재 비밀번호를 입력하면 꺼집니다')
    : on
    ? (C.autoLockMin > 0 ? T('켜짐 · 브라우저 재시작 또는 {n}분 미사용 시 잠김', { n: C.autoLockMin }) : T('켜짐 · 브라우저를 다시 열 때 잠김'))
    : T('꺼짐 · 비밀번호 없이 바로 사용합니다');
  show('lkOn', lockMode === 'on'); show('lkOff', lockMode === 'off'); show('lkChange', lockMode === 'change');
  show('lkOpts', on && !lockMode);
  show('btnLock', on && W.unlocked);
}
const clearLockInputs = () => ['nextPw', 'nextPw2', 'offPw', 'chCur', 'chNew', 'chNew2'].forEach((x) => { $(x).value = ''; });
const setLockMode = (m) => { lockMode = m; clearLockInputs(); say('secMsg', ''); renderLock(); const f = { on: 'nextPw', off: 'offPw', change: 'chCur' }[m]; if (f) $(f).focus(); };
$('lockToggle').onchange = () => {
  const want = $('lockToggle').checked;
  if (lockMode) return setLockMode(null);           // toggling back = cancel
  setLockMode(want ? 'on' : 'off');
};
document.querySelectorAll('[data-lkcancel]').forEach((b) => { b.onclick = () => setLockMode(null); });
$('btnLkChange').onclick = () => setLockMode('change');
async function applyPw(oldPassword, newPassword, okText) {
  const r = await send({ type: 'wallet:setPassword', oldPassword, newPassword });
  if (r.error) return say('secMsg', pwErr(r.error), 'bad');
  lockMode = null; clearLockInputs(); await refresh(); say('secMsg', okText, 'ok');
}
$('btnLkOn').onclick = () => {
  const pw = $('nextPw').value;
  if (pw.length < 8) return say('secMsg', T('8자 이상 입력하세요'), 'warn');
  if (pw !== $('nextPw2').value) return say('secMsg', T('비밀번호 확인이 일치하지 않습니다'), 'warn');
  applyPw(null, pw, T('잠금을 켰습니다'));
};
$('btnLkOff').onclick = () => { if (!$('offPw').value) return say('secMsg', T('현재 비밀번호를 입력하세요'), 'warn'); applyPw($('offPw').value, null, T('잠금을 껐습니다')); };
$('btnLkChangeDo').onclick = () => {
  const pw = $('chNew').value;
  if (pw.length < 8) return say('secMsg', T('새 비밀번호를 8자 이상 입력하세요'), 'warn');
  if (pw !== $('chNew2').value) return say('secMsg', T('새 비밀번호 확인이 일치하지 않습니다'), 'warn');
  applyPw($('chCur').value, pw, T('비밀번호를 바꿨습니다'));
};
[['nextPw2', 'btnLkOn'], ['offPw', 'btnLkOff'], ['chNew2', 'btnLkChangeDo']].forEach(([i, b]) => $(i).addEventListener('keydown', (e) => { if (e.key === 'Enter') $(b).click(); }));
$('btnLock').onclick = async () => { await send({ type: 'wallet:lock' }); tab = 'home'; await refresh(); };

// ---------- dialog ----------
// dialog({ title, body (html), yes, tone: 'danger'|'primary', password }) -> resolves { ok, password }; onYes may keep it open
function dialog({ title, body, yes = T('확인'), tone = 'primary', password = false, onYes = null }) {
  $('dlgTitle').textContent = title; $('dlgBody').innerHTML = body;
  $('dlgYes').textContent = yes; $('dlgYes').className = 'btn ' + (tone === 'danger' ? 'live' : 'primary');
  $('dlg').classList.toggle('danger', tone === 'danger');
  $('dlgNo').textContent = T('취소'); show('dlgNo', true); show('dlgYes', true);
  show('dlgPwField', password); $('dlgPw').value = ''; say('dlgMsg', '');
  show('dlg', true); if (password) $('dlgPw').focus();
  return new Promise((resolve) => {
    const close = (r) => { show('dlg', false); $('dlgPw').value = ''; $('dlgYes').onclick = $('dlgNo').onclick = null; resolve(r); };
    $('dlgNo').onclick = () => close({ ok: false });
    $('dlgYes').onclick = async () => {
      const r = { ok: true, password: $('dlgPw').value };
      if (onYes) { const keep = await onYes(r); if (keep) return; }
      close(r);
    };
    dlgClose = () => close({ ok: false });
  });
}
let dlgClose = null;
$('dlg').addEventListener('click', (e) => { if (e.target === $('dlg') && dlgClose) dlgClose(); });
// tray close buttons take the backdrop's path (cancel)
document.querySelectorAll('.modal .tx').forEach((b) => { b.onclick = () => b.closest('.modal').click(); });
document.addEventListener('keydown', (e) => {
  if ($('dlg').classList.contains('hidden')) return;
  if (e.key === 'Escape' && dlgClose) dlgClose();
  if (e.key === 'Enter' && document.activeElement === $('dlgPw')) $('dlgYes').click();
});

// wallet: private key / delete, both behind a warning dialog (and the lock password when the lock is on)
$('btnReveal').onclick = () => dialog({
  title: T('private key를 표시할까요?'),
  body: T('<div class="warnbox">이 key가 있으면 누구나 이 지갑의 자금을 옮길 수 있습니다. 화면 공유나 녹화 중이 아닌지 확인하세요.</div>'),
  yes: T('표시'), tone: 'danger', password: W.encrypted,
  onYes: async ({ password }) => {
    const r = await send({ type: 'wallet:reveal', password });
    if (r.error) { say('dlgMsg', pwErr(r.error), 'bad'); return true; }
    // same dialog, now showing the key; hidden again on close or after 60s
    $('dlgTitle').textContent = 'private key';
    $('dlgBody').innerHTML = `<div class="secretwrap"><div class="secret" id="dlgKey"></div>${COPY_BTN('data-copy-el="dlgKey"')}</div>`;
    $('dlgKey').textContent = r.secret;
    show('dlgPwField', false); show('dlgYes', false); say('dlgMsg', '');
    $('dlgNo').textContent = T('닫기');
    const t = setTimeout(() => dlgClose && dlgClose(), 60_000);
    const prev = dlgClose; dlgClose = () => { clearTimeout(t); $('dlgBody').innerHTML = ''; prev(); };
    $('dlgNo').onclick = dlgClose;
    return true;
  },
});
$('btnRemove').onclick = () => dialog({
  title: T('지갑을 삭제할까요?'),
  body: T('<div class="warnbox">private key를 백업하지 않았다면 이 지갑의 자금을 되찾을 수 없습니다.</div>'),
  yes: T('삭제'), tone: 'danger', password: W.encrypted,
  onYes: async ({ password }) => {
    const r = await send({ type: 'wallet:remove', password });
    if (r.error) { say('dlgMsg', pwErr(r.error), 'bad'); return true; }
    await setOnboard(null); tab = 'home'; await refresh();
    return false;
  },
});

// ---------- settings: empty token accounts ----------
let accScan = null;
const solStr = (lamports) => (lamports / 1e9).toFixed(4);
async function scanAccounts() {
  accScan = null;
  if (!W.exists || !(C.heliusApiKey || C.customRpcUrl)) { show('accCard', false); return; }
  show('accCard', true); show('accList', false); show('accActs', false);
  $('accSum').className = 'small mut'; $('accSum').textContent = T('확인 중…');
  const r = await send({ type: 'accounts:scan' });
  if (!r || r.error) { $('accSum').textContent = (r && (r.friendly || r.error)) || T('확인하지 못했습니다'); return; }
  accScan = r;
  const n = r.list.length;
  $('accSum').className = 'small';
  $('accSum').innerHTML = n ? T('{n}개 · <b>{sol} SOL</b> 회수 가능', { n, sol: solStr(r.lamports) }) : T('<span class="mut">정리할 계정이 없습니다</span>');
  $('accList').innerHTML = r.list.map((a) => `<div><span>${esc(a.symbol || short(a.mint))}</span><span class="dim">${solStr(a.lamports)} SOL</span></div>`).join('');
  show('accList', n > 0); show('accActs', n > 0);
}
$('btnAccClose').onclick = () => {
  const r = accScan; if (!r || !r.list.length) return;
  return dialog({
    title: T('빈 토큰 계정 {n}개를 닫을까요?', { n: r.list.length }),
    body: `<div class="small">${T('{sol} SOL이 지갑으로 돌아옵니다.', { sol: solStr(r.lamports) })}${r.fee >= r.lamports ? `<br><span class="warn">${T('수수료({fee} SOL)가 돌려받는 금액보다 큽니다.', { fee: (r.fee / 1e9).toFixed(6) })}</span>` : ''}</div>`,
    yes: T('정리'),
    onYes: async () => {
      $('dlgYes').disabled = true; say('dlgMsg', T('처리 중…'));
      const x = await send({ type: 'accounts:close', accounts: r.list.map((a) => a.account) });
      $('dlgYes').disabled = false;
      if (!x || x.error) { say('dlgMsg', (x && (x.friendly || x.error)) || T('실패했습니다'), 'bad'); return true; }
      say('accMsg', x.failed ? T('{n}개 정리, {f}개 실패 · +{sol} SOL', { n: x.closed, f: x.failed, sol: solStr(x.lamports) }) : T('{n}개 정리 · +{sol} SOL', { n: x.closed, sol: solStr(x.lamports) }), x.failed ? 'warn' : 'ok');
      scanAccounts();
      return false;
    },
  });
};

// ---------- loop ----------
async function renderAll() {
  const v = view();
  if (v === 'vHome') await renderHome();
  if (v === 'vSettings') renderSettings(); else settingsOpened = false;
  if (v === 'vBackup') await renderBackup();
  if (v === 'vHelius') renderHeliusStep();
  if (v === 'vLocked') $('lockedAddr').textContent = W.pubkey || '';
}
async function refresh() { await load(); await renderAll(); }

// language: 한국어 / English (settings). Static markup is translated in place; dynamic parts re-render.
const renderLang = () => {
  document.querySelectorAll('#langSeg button, #langMini button').forEach((b) => b.classList.toggle('on', b.dataset.lang === TE_I18N.lang));
  $('langTitle').textContent = TE_I18N.lang === 'ko' ? 'Language' : '언어'; // in the other language, so it can be found either way
};
document.querySelectorAll('#langSeg button, #langMini button').forEach((b) => { b.onclick = () => TE_I18N.setLang(b.dataset.lang); });
TE_I18N.onChange(() => { TE_I18N.dom(document.body); renderLang(); renderSite(); renderAll(); });
TE_I18N.init().then(() => { TE_I18N.dom(document.body); renderLang(); renderSite(); refresh(); });
setInterval(async () => { if (!document.hidden && tab === 'home') { await load(); renderAll(); } }, 3000);
