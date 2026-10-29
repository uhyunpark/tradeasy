// DX - MAIN world hook (document_start). Read-only taps, results are postMessage'd to content.js:
//  - GMGN XHR: mutil_window_token_info (exchange, pool, name/symbol/logo), recommend_slippage (auto slippage)
//  - Axiom fetch: token-and-best-pair-info (protocol, best pair, name/ticker/image)
//  - Axiom client-socket SharedWorker port -> blockhash + trades for the current token
// Never block or modify the page's traffic (blocking the SharedWorker crashed Axiom).
// Hot path uses string ops only; JSON.parse runs just for the frames we use.
(() => {
  if (window.__DX_HOOKED__) return;
  window.__DX_HOOKED__ = true;
  const TAG = '__DX__';
  const post = (kind, payload) => { try { window.postMessage({ [TAG]: true, kind, payload }, location.origin); } catch (_) {} };
  const MINT_RE = /\/(?:token|meme)\/([1-9A-HJ-NP-Za-km-z]{32,44})/;
  const currentMint = () => (location.pathname.match(MINT_RE) || [])[1] || null;

  // ---- HTTP taps (fetch + XHR): read-only, only for the few endpoints we use ----
  const WANT = /\/mutil_window_token_info|\/recommend_slippage\/|\/token-and-best-pair-info/;
  function onJson(url, j) {
    if (!j) return;
    if (url.indexOf('/mutil_window_token_info') !== -1) { // GMGN: exchange + pool per token
      for (const d of j.data || []) {
        const pool = d && d.pool;
        if (d && d.address) post('pool-info', { mint: d.address, exchange: pool ? pool.exchange || null : null, pool: pool ? pool.pool_address || null : null,
          name: d.name || null, symbol: d.symbol || null, image: d.logo || d.image || null });
      }
      return;
    }
    const ms = /\/recommend_slippage\/sol\/([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(url); // GMGN "auto" slippage
    if (ms) {
      const d = j.data;
      if (d) post('slippage', { mint: ms[1], buy: Number(d.recommend_slippage) || null, sell: Number(d.recommend_sell_slippage) || null });
      return;
    }
    if (url.indexOf('/token-and-best-pair-info') !== -1) { // Axiom: protocol hint
      const t = j.token || {}, b = j.bestPairInfo || {};
      if (t.tokenAddress) post('pair-info', { mint: t.tokenAddress, protocol: b.protocol || null, pair: b.bestPairAddress || null,
        name: t.tokenName || null, symbol: t.tokenTicker || null, image: t.tokenImage || null });
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = origFetch.apply(this, arguments);
    if (WANT.test(url)) p.then((res) => res.clone().json()).then((j) => onJson(url, j)).catch(() => {});
    return p;
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__dxUrl = String(u || ''); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (this.__dxUrl && WANT.test(this.__dxUrl)) {
      this.addEventListener('load', () => {
        try {
          const j = this.responseType === 'json' ? this.response : (this.responseType === '' || this.responseType === 'text') ? JSON.parse(this.responseText) : null;
          onJson(this.__dxUrl, j);
        } catch (_) {}
      });
    }
    return XS.apply(this, arguments);
  };

  // ---- SharedWorker port tap ----
  const ROOM_KEY = '"room":"';
  let lastBh = 0;
  function onFrame(f) {
    if (typeof f !== 'string') return;
    const a = f.indexOf(ROOM_KEY);
    if (a < 0) return;
    const b = f.indexOf('"', a + ROOM_KEY.length);
    const room = f.slice(a + ROOM_KEY.length, b);
    if (room === 'sol-v2|blockhash') {
      const now = Date.now();
      if (now - lastBh < 1500) return;
      lastBh = now;
      try { const c = JSON.parse(f).content; if (Array.isArray(c) && typeof c[0] === 'string') post('blockhash', { hash: c[0] }); } catch (_) {}
      return;
    }
    const mint = currentMint();
    if (mint && room === 'sol-v2|t:' + mint) {
      try {
        const c = JSON.parse(f).content; // [sig, time, side, wallet, mint, pair, ...]
        if (Array.isArray(c)) post('trade', { sig: c[0], side: c[2], wallet: c[3], mint: c[4] });
      } catch (_) {}
    }
  }
  if (typeof window.SharedWorker === 'function') {
    const OrigSW = window.SharedWorker;
    window.SharedWorker = new Proxy(OrigSW, {
      construct(target, args, newTarget) {
        const w = Reflect.construct(target, args, newTarget);
        try {
          w.port.addEventListener('message', (e) => {
            const d = e.data;
            if (d && d.kind === 'frames' && Array.isArray(d.frames)) for (const f of d.frames) onFrame(f);
          });
        } catch (_) {}
        return w;
      },
    });
  }
  // ---- row token lookup for one-click buttons (Axiom lists): React props carry the row's pair info ----
  // content.js marks the clicked button with data-dx-q and asks; only the MAIN world can read React fibers.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== true || e.data.kind !== 'resolve-row') return;
    const id = String(e.data.payload && e.data.payload.id || '');
    const el = id && document.querySelector('[data-dx-q="' + id.replace(/[^a-z0-9]/gi, '') + '"]');
    let info = null;
    try {
      const fk = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      for (let f = fk ? el[fk] : null, i = 0; f && i < 16 && !info; f = f.return, i++) {
        const p = f.memoizedProps || {};
        const c = [p.pairInfo, p.row, p.pair, p.token, p].find((x) => x && typeof x === 'object' && typeof x.tokenAddress === 'string');
        if (c) info = { mint: c.tokenAddress, pool: c.pairAddress || null, protocol: c.protocol || null, quote: c.quoteTokenAddress || null };
      }
    } catch (_) {}
    post('row-info', { id, info });
  });
  // ---- DX average buy line on the terminal's TradingView chart ----
  // The chart may plot price or market cap, in USD or SOL; all are proportional to the token's SOL price, so the
  // line level = avg * (chart close / DX mid price), with the ratio smoothed over recent samples.
  let avgShape = null, ratios = [], lastMint = null;
  const chartApi = () => {
    for (const f of document.querySelectorAll('iframe')) {
      try { const api = f.contentWindow && f.contentWindow.tradingViewApi; if (api && api.activeChart) return api.activeChart(); } catch (_) {}
    }
    return null;
  };
  const removeAvg = (ch) => { try { if (avgShape && ch) ch.removeEntity(avgShape); } catch (_) {} avgShape = null; };
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== true || e.data.kind !== 'avg-line') return;
    const p = e.data.payload || {};
    const ch = chartApi();
    if (!ch) return;
    try {
      const sym = String(ch.symbol() || '').toUpperCase();
      if (p.mint && sym.includes('|') && !sym.includes(String(p.mint).toUpperCase()) && document.querySelectorAll('iframe[id^=tradingview_]').length > 1) return; // another token's chart
      if (p.mint !== lastMint) { removeAvg(ch); ratios = []; lastMint = p.mint; }
      if (!p.avg || !p.spot) return removeAvg(ch);
      const now = Math.floor(Date.now() / 1000);
      const d = await ch.exportData({ includeTime: true, includeSeries: true, includedStudies: [], from: now - 600 });
      const last = d && d.data && d.data[d.data.length - 1];
      const ci = d.schema.findIndex((s) => s.plotTitle === 'close');
      const close = last ? Number(last[ci > 0 ? ci : 4]) : NaN;
      if (!(close > 0)) return;
      ratios.push(close / p.spot); if (ratios.length > 7) ratios.shift();
      const k = [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
      const price = p.avg * k;
      const sh = avgShape && ch.getShapeById(avgShape);
      if (sh) { sh.setPoints([{ time: now, price }]); return; }
      avgShape = await ch.createShape({ time: now, price }, {
        shape: 'horizontal_line', lock: true, disableSelection: true, disableSave: true, disableUndo: true, showInObjectsTree: false,
        text: p.label || 'DX avg',
        overrides: { linecolor: '#a855f7', linestyle: 2, linewidth: 1, showLabel: true, textcolor: '#c084fc', horzLabelsAlign: 'left', vertLabelsAlign: 'bottom', fontsize: 11, bold: true },
      });
    } catch (_) { avgShape = null; }
  });
})();
