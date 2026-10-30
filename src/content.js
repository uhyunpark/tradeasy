// Tradeasy - content script (isolated world) on supported terminals (Axiom, GMGN).
// Bridges the MAIN-world hook to the background, reads the terminal's presets from
// localStorage, and renders the Tradeasy badge / popover / toasts in its own overlay layer
// (never inside the terminal's React DOM).
(() => {
  const TAG = '__TRADEASY__';
  const T = (k, v) => globalThis.TE_I18N.T(k, v);
  globalThis.TE_I18N.init();
  // After the extension is updated or reloaded, this script keeps running in already-open
  // tabs but can no longer talk to the background ("orphaned"). Detect that and retire.
  const timers = [];
  const every = (fn, ms) => { timers.push(setInterval(fn, ms)); };
  let dead = false, retire = () => {};
  const alive = () => { try { return !!chrome.runtime.id; } catch (_) { return false; } };
  const send = (msg) => new Promise((res) => {
    if (dead || !alive()) { retire(); return res({ error: 'extension reloaded' }); }
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || { error: 'no response' }); }); }
    catch (e) { if (/context invalidated/i.test(e.message)) retire(); res({ error: e.message }); }
  });
  const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
  const QUICK_RE = /^(Buy|Sell)\s+([\d.,]+)\s*(SOL|%)?$/i; // one-click buttons: "Buy 0.03 SOL", "Sell 50%" 
  const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
  const json = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } };

  // ---------- site adapters ----------
  // Each adapter maps a terminal's URL, presets and main action button to one shape.
  // Preset fields left null ("auto" on the terminal) are filled by Tradeasy defaults in the background.
  const ADAPTERS = {
    axiom: {
      name: 'Axiom',
      mintRe: new RegExp(`/(?:token|meme)/(${B58})`),
      // market button of the trade panel: "Buy TOKEN" / "Sell TOKEN" (not list quick buys like "Buy 0.03 SOL")
      mainSide(text, r) { const m = /^(Buy|Sell)\s+\S/.exec(text); return m && !QUICK_RE.test(text) && r.width >= 140 && r.height >= 24 ? m[1].toLowerCase() : null; },
      intercept: true, // Tradeasy mode: the terminal's own buttons are executed by Tradeasy
      readSettings() {
        const s = json('settings');
        if (!s || !s.solPresets) return null;
        const key = s.currentSolPresetKey;
        const p = s.solPresets[key] || {};
        const norm = (c) => c && ({
          slippage: num(c.slippage), priorityFeeSol: num(c.priorityFeeSol) ?? 0, bribeFeeSol: num(c.bribeFeeSol) ?? 0,
          maxFeeSol: num(c.maxFeeSol), mevProtection: !!c.mevProtection, autoFee: !!c.autoFee,
        });
        return {
          label: `Axiom ${key}`, preset: { buy: norm(p.buy), sell: norm(p.sell) },
          solQuickSets: (s.solQuickSets || []).map(num).filter(Boolean).slice(0, 8),
          percentageQuickSets: (s.percentageQuickSets || []).map(num).filter((x) => x && x <= 100).slice(0, 6),
          // Axiom stores the buy amount unit as "native" (SOL) or a fiat unit such as "usd"
          buyUnitIsSol: !s.solBuyAmountUnit || /^(native|sol)$/i.test(String(s.solBuyAmountUnit)),
          buyUnit: String(s.solBuyAmountUnit || 'native'),
        };
      },
    },
    gmgn: {
      name: 'GMGN',
      mintRe: new RegExp(`/sol/token/(?:[A-Za-z0-9]+_)?(${B58})`),
      mainSide(text, r) { const m = /^(Buy|Sell)$/.exec(text); return m && r.width >= 180 && r.height >= 28 ? m[1].toLowerCase() : null; },
      readSettings() {
        const t = json('tradeConfigsV12');
        const sol = t && t.sol;
        if (!sol || !sol.buy || !sol.sell) return null;
        const pick = (side) => { const x = sol[side]; return (x.tradeConfigs || [])[x.tradeConfigIndex || 0] || null; };
        const norm = (c) => c && ({
          slippage: c.slippageType === 'auto' ? null : num(c.slippageCustom),
          priorityFeeSol: c.priorityType === 'auto' ? null : num(c.priorityCustom),
          bribeFeeSol: c.tipType === 'auto' ? null : num(c.tipCustom),
          maxFeeSol: num(c.autoGasMax), mevProtection: !!c.openMEV, autoFee: false,
        });
        return {
          label: `GMGN P${(sol.buy.tradeConfigIndex || 0) + 1}/P${(sol.sell.tradeConfigIndex || 0) + 1}`,
          preset: { buy: norm(pick('buy')), sell: norm(pick('sell')) },
          solQuickSets: (sol.buy.quickAmount || []).map(num).filter(Boolean).slice(0, 8),
          percentageQuickSets: (sol.sell.quickAmount || []).map(num).filter((x) => x && x <= 100).slice(0, 6),
          buyUnitIsSol: true,
        };
      },
      // GMGN prints the effective values under the main button: [slippage, priority, tip, MEV]
      // e.g. "Auto | 0.00014 | <0.01 | Red." -> only exact numbers are used.
      displayed(btn) {
        let el = btn, row = null;
        for (let i = 0; i < 4 && el && !row; i++) {
          el = el.parentElement;
          const sib = el && el.nextElementSibling;
          if (sib && sib.querySelectorAll('span').length >= 3) row = sib;
        }
        if (!row) return {};
        const vals = [...row.querySelectorAll('span')].map((x) => (x.innerText || '').trim()).filter(Boolean);
        const exact = (t) => (t && /^[0-9.]+%?$/.test(t) ? num(t.replace('%', '')) : null);
        return { slippage: exact(vals[0]), priorityFeeSol: exact(vals[1]), bribeFeeSol: exact(vals[2]) };
      },
    },
  };
  const SITE = /(^|\.)axiom\.trade$/.test(location.hostname) ? 'axiom' : /(^|\.)gmgn\.ai$/.test(location.hostname) ? 'gmgn' : null;
  if (!SITE) return;
  const A = ADAPTERS[SITE];
  const urlMint = () => (location.pathname.match(A.mintRe) || [])[1] || null;
  // presets from storage; "auto" fields filled from what the terminal displays (if anything)
  const readSettings = (btn) => {
    const st = A.readSettings();
    if (st && btn && A.displayed) {
      const shown = A.displayed(btn);
      for (const side of ['buy', 'sell']) {
        const p = st.preset[side];
        if (!p || side !== sideOf(btn)) continue;
        for (const k of ['slippage', 'priorityFeeSol', 'bribeFeeSol']) if (p[k] == null && shown[k] != null) { p[k] = shown[k]; (p.fromScreen = p.fromScreen || []).push(k); }
      }
    }
    // GMGN "auto" slippage = GMGN's own recommendation for this token
    const rec = recSlippage.get(urlMint());
    if (st && rec) {
      for (const side of ['buy', 'sell']) {
        const p = st.preset[side];
        if (p && p.slippage == null && rec[side]) { p.slippage = rec[side]; (p.fromScreen = p.fromScreen || []).push('slippage'); }
      }
    }
    return st;
  };
  const btnText = (btn) => (btn.innerText || btn.textContent || '').trim().replace(/\s+/g, ' ');
  const sideOf = (btn) => A.mainSide(btnText(btn), btn.getBoundingClientRect());

  // ---------- hook bridge (Axiom only: protocol hint, blockhash, trades) ----------
  const protocolByMint = new Map();
  const poolByMint = new Map(); // pool address reported by the terminal (verified on-chain in the background)
  const recSlippage = new Map(); // GMGN recommend_slippage per mint
  const metaByMint = new Map(); // token name/symbol/image as the terminal shows it
  const rowWaiters = new Map(); // one-click button lookups answered by hook.js
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const setMeta = (p) => {
    const m = { name: str(p.name, 64), symbol: str(p.symbol, 24), image: typeof p.image === 'string' && /^https:\/\//.test(p.image) ? p.image.slice(0, 400) : null };
    if (m.name || m.symbol) metaByMint.set(p.mint, m);
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== true) return;
    const { kind, payload: p } = e.data;
    if (kind === 'pool-info' && p && p.mint) {
      if (p.exchange) protocolByMint.set(p.mint, p.exchange);
      if (p.pool) poolByMint.set(p.mint, p.pool);
      setMeta(p);
      if (p.mint === urlMint()) sendWatch(true);
    } else if (kind === 'slippage' && p && p.mint) {
      recSlippage.set(p.mint, p);
    } else if (kind === 'pair-info' && p && p.mint) {
      protocolByMint.set(p.mint, p.protocol);
      if (p.pair) poolByMint.set(p.mint, p.pair);
      setMeta(p);
      if (p.mint === urlMint()) sendWatch(true);
    } else if (kind === 'row-info' && p && rowWaiters.has(p.id)) {
      rowWaiters.get(p.id)(p.info); rowWaiters.delete(p.id);
    } else if (kind === 'blockhash' && p && typeof p.hash === 'string') {
      send({ type: 'feed:blockhash', hash: p.hash });
    } else if (kind === 'trade' && p && p.mint === urlMint()) {
      send({ type: 'feed:trade', sig: p.sig, side: p.side, wallet: p.wallet, mint: p.mint });
    }
  });

  // ---------- watch current token ----------
  let watchedMint = null, lastWatchAt = 0;
  function sendWatch(force) {
    const mint = urlMint();
    if (!mint) { if (watchedMint) { send({ type: 'unwatch' }); watchedMint = null; } return; }
    if (!force && mint === watchedMint && Date.now() - lastWatchAt < 10_000) return;
    watchedMint = mint; lastWatchAt = Date.now();
    send({ type: 'watch', mint, protocol: protocolByMint.get(mint) || null, pool: poolByMint.get(mint) || null, site: SITE, meta: metaByMint.get(mint) || null });
  }
  every(() => sendWatch(false), 700);

  function findAmountInput(btn) {
    let el = btn;
    for (let i = 0; i < 10 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const inp = [...el.querySelectorAll('input')].find((x) => !['checkbox', 'radio', 'hidden', 'search'].includes(x.type) && x.offsetParent);
      if (inp) return inp;
    }
    return null;
  }

  // ---------- UI: overlay layer ----------
  const css = `
  #te-layer{/* @te-theme */}
  #te-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483646;font:12px/1.4 var(--te-font)}
  .te-badge{position:fixed;z-index:2;pointer-events:auto;display:inline-flex;align-items:center;gap:4px;padding:1px 7px;font-size:10px;font-weight:700;
    letter-spacing:.4px;color:var(--te-on-accent);background:var(--te-accent);border-radius:var(--te-r-xs);cursor:pointer;user-select:none;box-shadow:0 0 0 2px var(--te-bg)}
  .te-badge.sim{background:var(--te-sim-fill);color:var(--te-on-fill)}
  .te-badge.off{background:var(--te-surface-2);color:var(--te-muted)}
  .te-badge.tg{gap:5px;padding:2px 4px 2px 7px;border-radius:999px;font-size:10px;box-shadow:none}
  .te-badge.tg .sw{position:relative;width:20px;height:12px;border-radius:999px;background:rgba(0,0,0,.22);flex:0 0 20px;transition:background .15s}
  .te-badge.tg .sw::after{content:'';position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:currentColor;transition:transform .15s}
  .te-badge.tg:not(.off) .sw::after{transform:translateX(8px)}
  .te-badge.tg.off .sw{background:var(--te-surface-3)}.te-badge.tg.off .sw::after{background:var(--te-muted)}
  .te-badge.tg:hover{filter:brightness(1.1)}
  .te-badge.tg .md{display:inline-grid;padding:0 4px;border-radius:999px;background:rgba(0,0,0,.22);font-size:8px;line-height:12px;letter-spacing:.5px}
  .te-badge.tg .md>span{grid-area:1/1;text-align:center}.te-badge.tg.sim .md>:last-child,.te-badge.tg:not(.sim) .md>:first-child{visibility:hidden}
  .te-cover *{color:var(--te-on-accent) !important}
  .te-cover.sim *{color:var(--te-on-fill) !important}
  .te-cover{position:fixed;z-index:1;pointer-events:auto;display:flex;align-items:center;justify-content:center;box-sizing:border-box;
    cursor:pointer;user-select:none;color:var(--te-on-accent);white-space:nowrap;overflow:hidden;
    background:linear-gradient(100deg,var(--te-accent-deep) 0%,var(--te-accent) 45%,var(--te-accent-hover) 100%);
    box-shadow:inset 0 0 0 1px var(--te-line-strong),0 0 12px var(--te-accent-glow);
    animation:teglow 2.4s ease-in-out infinite;transition:filter .12s,transform .06s}
  .te-cover.sim{color:var(--te-on-fill);text-shadow:0 1px 2px rgba(0,0,0,.35);
    background:linear-gradient(100deg,var(--te-sim-fill) 0%,color-mix(in srgb,var(--te-sim-fill) 80%,var(--te-sim)) 100%);
    box-shadow:inset 0 0 0 1px var(--te-line-strong),0 0 12px color-mix(in srgb,var(--te-sim) 55%,transparent);animation-name:teglowsim}
  .te-cover:hover{filter:brightness(1.08)}.te-cover:active{transform:scale(.985)}
  .te-cover.busy{opacity:.7;cursor:progress;animation:none}
  @keyframes teglow{50%{box-shadow:inset 0 0 0 1px var(--te-line-strong),0 0 20px var(--te-accent-glow),0 0 34px var(--te-accent-soft)}}
  @keyframes teglowsim{50%{box-shadow:inset 0 0 0 1px var(--te-line-strong),0 0 20px color-mix(in srgb,var(--te-sim) 80%,transparent),0 0 34px var(--te-sim-soft)}}
  .te-pop{position:fixed;pointer-events:auto;width:284px;box-sizing:border-box;background:var(--te-surface);color:var(--te-fg);border-radius:var(--te-r-lg);
    padding:12px;box-shadow:inset 0 0 0 1px var(--te-line),var(--te-shadow-pop)}
  .te-pop h4{margin:0 0 8px;font-size:13px;font-weight:700;display:flex;justify-content:space-between;align-items:center}
  .te-pop .mut{color:var(--te-muted);font-size:11px}
  .te-pop .warn{color:var(--te-warn);font-size:11px;margin-top:4px}
  .te-pop *{box-sizing:border-box}
  .te-pop .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px}
  .te-pop button{background:var(--te-surface-2);color:var(--te-fg);border:0;border-radius:10px;padding:7px 9px;cursor:pointer;font:inherit;text-align:left;line-height:1.3;min-width:0;
    transition:background .12s,transform .1s}
  .te-pop button b{display:block;font-size:12px}
  .te-pop button small{display:block;font-size:10px;color:var(--te-muted);min-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .te-pop button small .hi{color:var(--te-warn)}.te-pop button small .vhi{color:var(--te-sell)}
  .te-pop button.main{grid-column:1/-1;background:var(--te-accent);color:var(--te-on-accent)}
  .te-pop button.main small{color:color-mix(in srgb,var(--te-on-accent) 75%,var(--te-accent))}
  .te-pop button.main small .hi{color:color-mix(in srgb,var(--te-warn) 35%,var(--te-on-accent))}.te-pop button.main small .vhi{color:color-mix(in srgb,var(--te-live) 70%,var(--te-on-accent))}
  .te-pop button.sell{background:var(--te-sell-soft);color:var(--te-sell)}
  .te-pop button:hover:not(:disabled){background:var(--te-surface-3)}
  .te-pop button.main:hover:not(:disabled){background:var(--te-accent-hover)}
  .te-pop button.sell:hover:not(:disabled){background:color-mix(in srgb,var(--te-sell) 22%,transparent)}
  .te-pop button:active:not(:disabled){transform:scale(.97)}
  .te-pop button:disabled{opacity:.4;cursor:default}
  .te-tag{display:inline-block;padding:0 5px;border-radius:var(--te-r-xs);font-size:10px;font-weight:700;margin-left:4px}
  .te-tag.sim{background:var(--te-sim-soft);color:var(--te-sim)}.te-tag.live{background:var(--te-live-soft);color:var(--te-sell)}
  .te-toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;pointer-events:auto;width:330px}
  .te-toast{display:flex;gap:10px;align-items:flex-start;background:var(--te-surface);color:var(--te-fg);border-radius:var(--te-r-lg);padding:12px 12px 12px 14px;
    box-shadow:inset 0 0 0 1px var(--te-line),var(--te-shadow-pop);font:13px/1.45 var(--te-font);max-height:50vh;overflow:auto;animation:tein .26s var(--te-spring)}
  @keyframes tein{from{opacity:0;transform:translateY(10px)}}
  .te-toast .ic{flex:0 0 22px;height:22px;border-radius:50%;display:grid;place-items:center;margin-top:1px;background:var(--te-surface-2);color:var(--te-muted)}
  .te-toast .ic svg{width:13px;height:13px}
  .te-toast.ok .ic{background:var(--te-buy-soft);color:var(--te-ok)}.te-toast.err .ic{background:var(--te-live-soft);color:var(--te-bad)}
  .te-toast .ic.spin{border:2px solid var(--te-surface-3);border-top-color:var(--te-accent);background:transparent;animation:tespin .8s linear infinite;box-sizing:border-box}
  @keyframes tespin{to{transform:rotate(360deg)}}
  .te-toast .bd{flex:1;min-width:0;word-break:break-word}
  .te-toast .t{font-weight:700;font-size:14px;margin-bottom:2px}
  .te-toast .m{font-size:13px;color:var(--te-fg)}
  .te-toast .sub{color:var(--te-muted);font-size:12px;margin-top:2px}
  .te-toast .lk{margin-top:4px;font-size:12px}
  .te-toast details{margin-top:6px;color:var(--te-muted);font-size:11px}
  .te-toast details summary,.te-toast a{color:var(--te-accent);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--te-line-strong)}
  .te-toast details summary{cursor:pointer;list-style:none}
  .te-toast a:hover,.te-toast details summary:hover{text-decoration-color:currentColor}
  .te-toast details pre{margin:4px 0 0;font:10px/1.4 var(--te-mono);white-space:pre-wrap;word-break:break-all}
  .te-toast .x{flex:0 0 20px;height:20px;border:0;background:transparent;color:var(--te-muted);cursor:pointer;padding:0;display:grid;place-items:center;border-radius:50%}
  .te-toast .x:hover{background:var(--te-surface-2);color:var(--te-fg)}.te-toast .x svg{width:12px;height:12px}
  @media (prefers-reduced-motion:reduce){.te-toast{animation:none}.te-cover{animation:none}}`;
  let layer = null, toasts = null;
  function getLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div'); layer.id = 'te-layer';
    const st = document.createElement('style'); st.textContent = css; layer.appendChild(st);
    toasts = document.createElement('div'); toasts.className = 'te-toasts'; layer.appendChild(toasts);
    document.documentElement.appendChild(layer);
    return layer;
  }

  const SVG = (d, w = 3) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONS = { ok: SVG('<path d="M20 6L9 17l-5-5"/>'), err: SVG('<path d="M18 6L6 18M6 6l12 12"/>') };
  // kind: 'ok' | 'err' | '' (pending: spinner)
  function toast(text, kind = '', html = false, ttl = 12_000) {
    getLayer();
    const t = document.createElement('div'); t.className = 'te-toast ' + kind;
    const ic = document.createElement('div'); ic.className = 'ic' + (kind ? '' : ' spin'); ic.innerHTML = ICONS[kind] || '';
    const body = document.createElement('div'); body.className = 'bd';
    if (html) body.innerHTML = text; else body.textContent = text;
    const x = document.createElement('button'); x.className = 'x'; x.title = T('닫기'); x.innerHTML = SVG('<path d="M18 6L6 18M6 6l12 12"/>', 2.5); x.onclick = () => t.remove();
    t.append(ic, body, x); toasts.prepend(t);
    if (ttl) setTimeout(() => t.remove(), ttl);
    return body;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- formatting ----------
  const fmtNum = (n) => {
    if (n == null || !Number.isFinite(n)) return '-';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    if (a >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return n.toPrecision(3);
  };
  // small prices: 0.0000000285 -> 0.0₇285 (zero count as subscript, like terminals do)
  const fmtPrice = (n) => {
    if (n == null || !Number.isFinite(n) || n <= 0) return '-';
    if (n >= 0.001) return n.toPrecision(4);
    const z = Math.floor(-Math.log10(n)); // zeros right after the decimal point
    const digits = Math.round(n * 10 ** (z + 3)).toString().slice(0, 3);
    return '0.0' + String(z).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[d]).join('') + digits;
  };
  const fmtSol = (n) => (n == null ? '-' : n >= 1 ? n.toFixed(3) : n.toFixed(4));
  const details = (lines) => `<details><summary>${T('자세히')}</summary><pre>${esc(lines.filter(Boolean).join('\n'))}</pre></details>`;
  const tx = (sig) => `<div class="lk"><a href="https://solscan.io/tx/${esc(sig)}" target="_blank" rel="noopener">${T('Solscan에서 보기 ↗')}</a></div>`;
  const card = (title, main, extra = '') => `<div class="t">${esc(title)}</div>${main ? `<div class="m">${esc(main)}</div>` : ''}${extra}`;

  // ---------- trade ----------
  let busy = false;
  async function doTrade(req, btn) {
    if (busy) return;
    busy = true; place();
    const s = readSettings(btn);
    const mint = req.mint || urlMint();
    const sym = (metaByMint.get(mint) || {}).symbol || T('토큰');
    const label = req.side === 'buy' ? T('매수 {sol} SOL', { sol: req.sol }) : T('매도 {pct}%', { pct: req.percent });
    if (!s || !s.preset || !s.preset[req.side]) { toast(card(T('{label} 실패', { label }), T('{site} 프리셋을 찾지 못했습니다.', { site: SITE })), 'err', true); busy = false; return; }
    const full = { ...req, mint, protocol: protocolByMint.get(mint) || null, pool: poolByMint.get(mint) || null, preset: s.preset[req.side], site: SITE };
    const pending = toast(card(modeCache === 'live' ? T('전송 중') : T('시뮬레이션 중'), label), '', true, 0);
    const r = await send({ type: 'trade', req: full });
    busy = false; place();
    pending.parentElement.remove();
    if (!r || r.error) {
      toast(card(T('{label} 실패', { label }), (r && r.friendly) || (r ? r.error : T('Tradeasy 응답 없음'))) + (r && r.friendly ? details([r.error]) : ''), 'err', true, 20_000);
      return;
    }
    const x = r.result;
    const symbol = x.symbol || sym;
    const e = x.expected;
    const what = !e ? label : req.side === 'buy' ? T('매수 {sol} SOL → 약 {tokens} {sym}', { sol: e.sol, tokens: fmtNum(e.tokens), sym: symbol }) : T('매도 {tokens} {sym} → 약 {sol} SOL', { tokens: fmtNum(e.tokens), sym: symbol, sol: fmtSol(e.sol) });
    if (x.simulated) {
      if (x.ok) toast(card(T('시뮬레이션 성공'), what), 'ok', true, 12_000);
      else toast(card(T('시뮬레이션 실패'), x.friendly || what, details(['err ' + JSON.stringify(x.err), ...(x.logs || [])])), 'err', true, 0);
    } else {
      sentToasts.set(x.signature, toast(card(T('전송됨 · 체결 확인 중'), what, tx(x.signature)), '', true, 60_000).parentElement);
    }
  }

  const sentToasts = new Map(); // signature -> "sent" toast, replaced by the result toast
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'confirm') return;
    const sent = sentToasts.get(msg.signature);
    if (sent) { sent.remove(); sentToasts.delete(msg.signature); }
    const c = msg.confirm;
    const sym = msg.symbol || (metaByMint.get(urlMint()) || {}).symbol || T('토큰');
    if (c.status === 'confirmed') {
      const a = c.actual;
      const main = !a ? '' : msg.side === 'buy' ? `${fmtSol(-a.sol)} SOL → ${fmtNum(a.tokens)} ${sym}` : `${fmtNum(-a.tokens)} ${sym} → ${fmtSol(a.sol)} SOL`;
      const pr = c.price;
      const priceLine = !pr ? '' : msg.side === 'buy'
        ? T('체결가 {p} SOL', { p: fmtPrice(pr.fill) }) + (pr.avg && pr.buys > 1 ? ' · ' + T('평균 매수가 {p} SOL', { p: fmtPrice(pr.avg) }) : '')
        : T('체결가 {p} SOL', { p: fmtPrice(pr.fill) }) + (pr.avg ? ' · ' + T('평균 매수가 {p} SOL', { p: fmtPrice(pr.avg) }) : '');
      const speed = c.slots == null ? '' : c.slots === 0 ? T('보낸 슬롯에서 바로 체결') : T('보낸 뒤 {n}슬롯 만에 체결 (약 {s}초)', { n: c.slots, s: (c.slots * 0.4).toFixed(1) });
      toast(card(T('체결 완료'), main, (priceLine ? `<div class="sub">${priceLine}</div>` : '') + (speed ? `<div class="sub">${speed}</div>` : '') + tx(msg.signature)), 'ok', true, 15_000);
    } else if (c.status === 'timeout') {
      toast(card(T('체결 확인 시간 초과'), T('45초 안에 확인되지 않았습니다.'), tx(msg.signature)), 'err', true, 0);
    } else {
      toast(card(T('체결 실패'), c.friendly || T('온체인에서 실패했습니다.'), tx(msg.signature) + details(['err ' + JSON.stringify(c.err), ...(c.logs || [])])), 'err', true, 0);
    }
  });

  // ---------- popover ----------
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); }, true);

  const impactHtml = (i) => (i == null ? '' : ` <span class="${i >= 15 ? 'vhi' : i >= 5 ? 'hi' : ''}">· ${i < 0.1 ? '<0.1' : i.toFixed(1)}%</span>`);
  async function openPop(btn, badge, side) {
    closePop();
    getLayer();
    pop = document.createElement('div'); pop.className = 'te-pop';
    const r = badge.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(innerWidth - 292, r.right - 284)) + 'px';
    // above the badge when there is room, otherwise below it (never covering the badge)
    if (r.top > 260) pop.style.bottom = Math.round(innerHeight - r.top + 6) + 'px';
    else pop.style.top = Math.round(r.bottom + 6) + 'px';
    layer.appendChild(pop);

    const s = readSettings(btn);
    const mint = urlMint();
    const info = await send({ type: 'state', mint });
    if (!pop) return;
    const mode = info && info.mode === 'live' ? 'live' : 'sim';
    const st = info && info.state;
    const sym = (metaByMint.get(mint) || {}).symbol || T('토큰');
    const head = `<h4><span>Tradeasy ${side === 'buy' ? T('매수') : T('매도')}<span class="te-tag ${mode}">${mode === 'live' ? 'LIVE' : T('시뮬레이션')}</span></span><span class="mut" data-x style="cursor:pointer">${T('닫기')}</span></h4>`;
    let status = '';
    if (!info || (info.error && !info.wallet)) status = T('Tradeasy에 연결할 수 없습니다. 탭을 새로고침하세요.');
    else if (!info.wallet.exists) status = T('Tradeasy 지갑이 없습니다. Tradeasy 팝업에서 만드세요.');
    else if (!info.wallet.unlocked) status = T('지갑이 잠겨 있습니다. Tradeasy 팝업에서 잠금을 해제하세요.');
    else if (info.error) status = info.friendly || info.error;
    else if (!st) status = T('토큰 정보를 불러오는 중...');
    const preset = s && s.preset ? s.preset[side] : null;
    const v = (x, unit = '') => (x == null ? 'auto' : x + unit);
    const presetLine = preset ? `${esc(s.label)} · slippage ${esc(v(preset.slippage, '%'))} · priority ${esc(v(preset.priorityFeeSol))} · tip ${esc(v(preset.bribeFeeSol))}${preset.mevProtection ? ' · ' + T('MEV 보호') : ''}` : T('프리셋을 찾지 못했습니다');
    const stLine = st ? T('Tradeasy 지갑 {sol} SOL · 보유 {tokens} {sym}', { sol: st.solBalance.toFixed(4), tokens: fmtNum(Number(st.tokenBalance)), sym: esc(sym) }) : '';
    let body = `<div class="mut">${presetLine}</div><div class="mut">${stLine}</div>` + (status ? `<div class="warn">${esc(status)}</div>` : '');
    const disabled = status ? 'disabled' : '';
    const sols = [], pcts = [];
    if (side === 'buy') {
      const inp = findAmountInput(btn);
      const amt = inp ? num(inp.value) : null;
      const solUnit = !s || s.buyUnitIsSol;
      body += '<div class="grid">';
      if (solUnit && amt) { body += `<button class="main" data-sol="${amt}" ${disabled}><b>${T('{amt} SOL 매수 (입력값)', { amt })}</b><small data-pv></small></button>`; sols.push(amt); }
      for (const q of (s ? s.solQuickSets : [])) { body += `<button data-sol="${q}" ${disabled}><b>${q} SOL</b><small data-pv></small></button>`; sols.push(q); }
      body += '</div>';
      if (!solUnit) body += T('<div class="mut">터미널 금액 단위가 SOL이 아니라 빠른 금액 버튼만 씁니다</div>');
    } else {
      const none = st && st.tokenBalanceRaw === '0';
      body += '<div class="grid">';
      for (const p of (s ? s.percentageQuickSets : [25, 50, 100])) { body += `<button class="sell" data-pct="${p}" ${disabled || (none ? 'disabled' : '')}><b>${p}%</b><small data-pv></small></button>`; pcts.push(p); }
      body += '</div>';
      if (none) body += T('<div class="mut">Tradeasy 지갑에 이 토큰이 없습니다</div>');
    }
    if (!status) body += `<div class="mut" style="margin-top:6px">${side === 'buy' ? T('버튼 아래: 예상 수령량 ({sym}) · 가격 영향', { sym: esc(sym) }) : T('버튼 아래: 예상 수령량 · 가격 영향')}</div>`;
    pop.innerHTML = head + body;
    pop.querySelector('[data-x]').addEventListener('click', closePop);
    pop.querySelectorAll('button[data-sol],button[data-pct]').forEach((b) => b.addEventListener('click', (e) => {
      if (!e.isTrusted) return; // page scripts cannot trigger trades
      e.preventDefault(); e.stopPropagation();
      const req = b.dataset.sol ? { side: 'buy', sol: Number(b.dataset.sol) } : { side: 'sell', percent: Number(b.dataset.pct) };
      closePop();
      doTrade(req, btn);
    }));
    // previews from the cached pool state (no RPC)
    if (!status && st) {
      const thisPop = pop;
      const q = await send({ type: 'quote', mint, side, sols, pcts });
      if (pop !== thisPop || !q || !q.items) return;
      const btns = [...pop.querySelectorAll(side === 'buy' ? 'button[data-sol]' : 'button[data-pct]')];
      q.items.forEach((it, i) => {
        const el = btns[i] && btns[i].querySelector('[data-pv]');
        if (!el) return;
        if (it.error) { el.textContent = /liquid|insufficient/i.test(it.error) ? T('유동성 부족') : T('견적 불가'); return; }
        el.innerHTML = (side === 'buy' ? `≈ ${fmtNum(it.out)}` : `≈ ${fmtSol(it.out)} SOL`) + impactHtml(it.impact);
      });
    }
  }

  // ---------- Tradeasy mode: the terminal's own buttons, executed by Tradeasy ----------
  // With Tradeasy mode on, trade clicks on the terminal's buttons are stopped in the capture phase (before the
  // page's React handlers, which fire on pointerdown) and executed by Tradeasy with the same amount and preset.
  // A trade click Tradeasy cannot read is blocked too, so a fee-charging terminal trade never slips through.
  const INTERCEPT = !!A.intercept;
  const MODE_KEY = 'teMode_' + SITE;
  let teMode = INTERCEPT;
  try { chrome.storage.local.get(MODE_KEY, (v) => { if (v && typeof v[MODE_KEY] === 'boolean') teMode = v[MODE_KEY]; place(); }); } catch (_) {}
  function setDxMode(on) {
    teMode = on;
    try { chrome.storage.local.set({ [MODE_KEY]: on }); } catch (_) {}
    place();
    toast(card(on ? T('Tradeasy 모드 켜짐') : T('Tradeasy 모드 꺼짐'), on ? T('{site} 버튼을 누르면 Tradeasy가 체결합니다', { site: A.name }) : T('터미널이 직접 체결합니다')), on ? 'ok' : 'err', true, 4000);
  }
  const NUM_RE = /^[\d.,]+%?$/;
  function panelOf(btn) {
    let el = btn;
    for (let i = 0; i < 10 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const input = [...el.querySelectorAll('input')].find((x) => x.offsetParent && !['checkbox', 'radio', 'hidden', 'search'].includes(x.type));
      if (input) return { el, input };
    }
    return null;
  }
  function classify(target) {
    const el = target && target.closest ? target.closest('button,[role=button]') : null;
    if (!el || (layer && layer.contains(el))) return null;
    const text = btnText(el);
    const side = A.mainSide(text, el.getBoundingClientRect());
    if (side) return { kind: 'main', el, side };
    if (NUM_RE.test(text)) { // amount chips of a trade panel
      for (const b of tracked.keys()) {
        const p = b.isConnected && panelOf(b);
        if (p && p.el.contains(el)) return { kind: 'chip', el, btn: b, panel: p, value: num(text.replace('%', '')), pct: text.endsWith('%') };
      }
      return null;
    }
    const m = QUICK_RE.exec(text);
    if (m) return { kind: 'quick', el, side: m[1].toLowerCase(), value: num(m[2]), pct: m[3] === '%' };
    return null;
  }
  // set a React-controlled input the way typing does (native setter + input event)
  function fillInput(input, value) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // token of a one-click button in a list: the row's React props (via hook.js), else a token link that
  // belongs to this row only (an ancestor holding a single one-click button)
  const isQuick = (b) => QUICK_RE.test(btnText(b));
  async function rowToken(el) {
    const id = 'q' + Math.random().toString(36).slice(2, 10);
    el.setAttribute('data-te-q', id);
    const info = await new Promise((res) => {
      rowWaiters.set(id, res);
      window.postMessage({ [TAG]: true, kind: 'resolve-row', payload: { id } }, location.origin);
      setTimeout(() => { if (rowWaiters.has(id)) { rowWaiters.delete(id); res(null); } }, 400);
    });
    el.removeAttribute('data-te-q');
    if (info && new RegExp(`^${B58}$`).test(info.mint || '')) {
      if (info.quote && info.quote !== 'So11111111111111111111111111111111111111112') throw new Error(T('SOL로 거래되는 토큰만 지원합니다'));
      if (info.protocol) protocolByMint.set(info.mint, info.protocol);
      if (info.pool && new RegExp(`^${B58}$`).test(info.pool)) poolByMint.set(info.mint, info.pool);
      return info.mint;
    }
    for (let x = el.parentElement, i = 0; x && i < 8; x = x.parentElement, i++) {
      if ([...x.querySelectorAll('button')].filter(isQuick).length > 1) break; // left the row
      for (const a of x.querySelectorAll('a[href]')) { const m = (a.getAttribute('href') || '').match(A.mintRe); if (m) return m[1]; }
    }
    return null;
  }
  let pendingPct = null; // last % chip filled into the sell input
  const isPctInput = (input) => /%/.test(input.placeholder || '') || /%/.test(((input.parentElement || {}).innerText || '') + ((input.parentElement && input.parentElement.parentElement || {}).innerText || ''));
  async function sellPercent(mint, value, pctHint) {
    if (pctHint) return Math.min(100, value);
    const r = await send({ type: 'state', mint }); // token amount -> % of the Tradeasy balance
    const bal = r && r.state ? Number(r.state.tokenBalance) : 0;
    if (!(bal > 0)) throw new Error(T('Tradeasy 지갑에 이 토큰이 없습니다'));
    return Math.min(100, (value / bal) * 100);
  }
  async function handle(c) {
    const fail = (m) => toast(card(T('Tradeasy 모드'), m), 'err', true, 8000);
    try {
      if (c.kind === 'chip') {
        fillInput(c.panel.input, c.value);
        pendingPct = c.pct || sideOf(c.btn) === 'sell' ? { v: c.value, at: Date.now() } : null;
        return;
      }
      if (c.kind === 'main') {
        const p = panelOf(c.el);
        const value = p && num(p.input.value);
        if (!value) return fail(T('금액을 입력하세요'));
        if (c.side === 'buy') {
          const s = readSettings(c.el);
          if (s && !s.buyUnitIsSol) return fail(T('{site} 매수 금액이 {unit} 단위입니다. 금액 옆 단위를 SOL로 바꿔주세요', { site: A.name, unit: s.buyUnit.toUpperCase() }));
          return doTrade({ side: 'buy', sol: value }, c.el);
        }
        const pct = (pendingPct && pendingPct.v === value) || isPctInput(p.input);
        return doTrade({ side: 'sell', percent: await sellPercent(urlMint(), value, pct) }, c.el);
      }
      if (c.kind === 'quick') {
        // the page's own token only for one-click buttons inside this page's trade panel
        const inPanel = [...tracked.keys()].some((b) => { const p = b.isConnected && panelOf(b); return p && p.el.contains(c.el); });
        const mint = (await rowToken(c.el)) || (inPanel ? urlMint() : null);
        if (!mint || !c.value) return fail(T('이 버튼의 토큰을 알 수 없어 막았습니다. Tradeasy 모드를 끄면 터미널에서 직접 거래됩니다'));
        if (c.side === 'buy') return doTrade({ side: 'buy', sol: c.value, mint }, null);
        return doTrade({ side: 'sell', percent: await sellPercent(mint, c.value, c.pct), mint }, null);
      }
    } catch (e) { fail(e.message); }
  }
  let lastAct = 0, lastEl = null;
  const actOnce = (el) => { if (el === lastEl && Date.now() - lastAct < 400) return false; lastAct = Date.now(); lastEl = el; return true; }; // double press guard
  if (INTERCEPT) {
    const onPointer = (e) => {
      if (!teMode) return;
      const c = classify(e.target);
      if (!c) return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      // extension was updated under this tab: keep blocking terminal trades (no silent fee trade), ask for a refresh
      if (dead) { if (e.type === 'pointerdown' && e.isTrusted) toast(T('Tradeasy가 업데이트되었습니다. 이 탭을 새로고침하세요. 방금 누른 주문은 전송되지 않았습니다.'), 'err', false, 8000); return; }
      // act once per press, on pointerdown (that is when the terminal itself would trade)
      if (e.type !== 'pointerdown' || e.button !== 0 || !e.isTrusted) return;
      if (!actOnce(c.el)) return;
      handle(c);
    };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'touchstart', 'touchend'].forEach((t) => window.addEventListener(t, onPointer, true));
    window.addEventListener('keydown', (e) => {
      if (!teMode || (e.key !== 'Enter' && e.key !== ' ')) return;
      const c = classify(document.activeElement);
      if (!c) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.isTrusted && !e.repeat && !dead) handle(c);
    }, true);
  }

  // ---------- badges ----------
  const tracked = new Map(); // button -> badge
  // While Tradeasy mode is on, the terminal's market button is covered by Tradeasy's own button of the same size and label:
  // the press lands on our element (outside the page's React tree), so the page never sees it. The capture-phase
  // blocking above stays as a second line (e.g. a press during a scroll before the cover moves).
  const covers = new Map(); // button -> cover
  function makeCover(btn) {
    const cv = document.createElement('div'); cv.className = 'te-cover';
    const cs = getComputedStyle(btn);
    Object.assign(cv.style, { font: cs.font, fontWeight: '700', borderRadius: cs.borderRadius, letterSpacing: cs.letterSpacing });
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['mousedown', 'mouseup', 'pointerup', 'click', 'dblclick', 'contextmenu'].forEach((t) => cv.addEventListener(t, swallow, true));
    cv.addEventListener('pointerdown', (e) => {
      swallow(e);
      if (!e.isTrusted || e.button !== 0 || busy) return;
      if (dead) return toast(T('Tradeasy가 업데이트되었습니다. 이 탭을 새로고침하세요. 방금 누른 주문은 전송되지 않았습니다.'), 'err', false, 8000);
      if (!actOnce(btn)) return;
      const side = sideOf(btn);
      if (side) handle({ kind: 'main', el: btn, side });
    }, true);
    return cv;
  }
  let modeCache = 'sim';
  function makeBadge(btn) {
    const b = document.createElement('span'); b.className = 'te-badge';
    if (INTERCEPT) { b.classList.add('tg'); b.innerHTML = '<span>Tradeasy</span><span class="md"><span>SIM</span><span>LIVE</span></span><span class="sw"></span>'; } // a small switch: Tradeasy mode on/off, with SIM/LIVE
    else { b.textContent = 'Tradeasy'; b.title = T('Tradeasy로 거래'); }
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['pointerdown', 'mousedown', 'mouseup'].forEach((t) => b.addEventListener(t, stop, true));
    b.addEventListener('click', (e) => {
      stop(e);
      if (!e.isTrusted) return;
      if (INTERCEPT) return setDxMode(!teMode);
      const side = sideOf(btn);
      if (!side || !urlMint()) return;
      openPop(btn, b, side);
    }, true);
    return b;
  }
  function place() {
    for (const [btn, badge] of tracked) {
      if (!btn.isConnected || !sideOf(btn)) { badge.remove(); tracked.delete(btn); continue; }
      const r = btn.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      badge.style.display = visible ? 'inline-flex' : 'none';
      if (INTERCEPT) { // switch sits just above the button's right end, not on it
        badge.style.left = Math.round(r.right - (badge.offsetWidth || 44)) + 'px';
        badge.style.top = Math.round(r.top - (badge.offsetHeight || 16) - 4) + 'px';
      } else {
        badge.style.left = Math.round(r.right - 16) + 'px';
        badge.style.top = Math.round(r.top - 9) + 'px';
      }
      badge.classList.toggle('sim', modeCache !== 'live');
      if (INTERCEPT) {
        badge.classList.toggle('off', !teMode);
        badge.setAttribute('role', 'switch'); badge.setAttribute('aria-checked', String(teMode));
        badge.title = teMode ? T('Tradeasy 모드: 이 버튼은 Tradeasy가 체결합니다 (누르면 끄기)') : T('Tradeasy 모드 꺼짐: 터미널이 체결합니다 (누르면 켜기)');
        let cv = covers.get(btn);
        if (!cv) { cv = makeCover(btn); getLayer().appendChild(cv); covers.set(btn, cv); }
        cv.style.display = visible && teMode ? 'flex' : 'none';
        Object.assign(cv.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        // same content as the terminal's button (e.g. "Buy TOKEN" + SOL icon + amount): copy its nodes, not its flattened text
        if (cv.dataset.src !== btn.innerHTML) { cv.replaceChildren(...[...btn.childNodes].map((n) => n.cloneNode(true))); cv.dataset.src = btn.innerHTML; }
        cv.classList.toggle('sim', modeCache !== 'live');
        cv.classList.toggle('busy', busy);
      }
    }
    for (const [btn, cv] of covers) if (!tracked.has(btn)) { cv.remove(); covers.delete(btn); }
  }
  function scan() {
    if (!urlMint()) return;
    for (const btn of document.querySelectorAll('button')) {
      if (tracked.has(btn) || (layer && layer.contains(btn)) || !sideOf(btn)) continue; // main action button only
      const badge = makeBadge(btn);
      getLayer().appendChild(badge);
      tracked.set(btn, badge);
    }
    place();
  }
  let pending = false;
  const schedule = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; scan(); }, 800); };
  every(() => { if (tracked.size) place(); }, 400);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  // Tradeasy average buy line on the terminal chart (hook.js draws it; only the MAIN world can reach the chart)
  every(async () => {
    const mint = urlMint();
    if (!mint || dead) return;
    const r = await send({ type: 'avgline', mint });
    const line = r && r.line;
    window.postMessage({ [TAG]: true, kind: 'avg-line', payload: line ? { mint, avg: line.avg, spot: line.spot, label: T('Tradeasy 평균 매수') } : { mint } }, location.origin);
  }, 3_000);
  const pollMode = async () => { const r = await send({ type: 'state', mint: urlMint() }); if (r && r.mode) { modeCache = r.mode === 'live' ? 'live' : 'sim'; place(); } };
  every(pollMode, 5_000); pollMode();
  // popup changes (SIMULATE/LIVE, Tradeasy mode switch) apply immediately
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || dead) return;
      if (ch.mode) { modeCache = ch.mode.newValue === 'live' ? 'live' : 'sim'; place(); }
      if (ch[MODE_KEY] && typeof ch[MODE_KEY].newValue === 'boolean' && ch[MODE_KEY].newValue !== teMode) { teMode = ch[MODE_KEY].newValue; place(); }
    });
  } catch (_) {}
  let observer = null;
  const start = () => { if (dead) return; scan(); observer = new MutationObserver(schedule); observer.observe(document.documentElement, { childList: true, subtree: true }); };
  retire = () => {
    if (dead) return; dead = true;
    timers.forEach(clearInterval);
    if (observer) observer.disconnect();
    window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place);
    document.querySelectorAll('#te-layer .te-badge, #te-layer .te-pop').forEach((x) => x.remove());
    // covers stay (and keep swallowing presses) so a stale tab never lets a terminal trade through
    toast(T('Tradeasy가 업데이트되었습니다. 이 탭을 새로고침하면 Tradeasy 버튼이 다시 동작합니다.'), 'err', false, 0);
  };
  every(() => { if (!alive()) retire(); }, 2000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
