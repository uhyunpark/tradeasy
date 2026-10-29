import { PublicKey } from '@solana/web3.js';
import * as vault from './vault.js';
import * as market from './market.js';
import * as trade from './trade.js';
import { getConfig, setConfig, testRpc } from './config.js';
import * as tokenMeta from './meta.js';
import * as quote from './quote.js';
import * as positions from './positions.js';
import * as withdraw from './withdraw.js';
import * as accounts from './accounts.js';
import { explain } from './errors.js';

// renamed storage key (v0.22): DX mode -> Tradeasy mode
chrome.storage.local.get(['dxMode_axiom', 'teMode_axiom']).then((s) => {
  if (s.dxMode_axiom === undefined) return;
  if (s.teMode_axiom === undefined) chrome.storage.local.set({ teMode_axiom: s.dxMode_axiom });
  chrome.storage.local.remove('dxMode_axiom');
}).catch(() => {});

// ---------- watched token (per tab) ----------
const watch = new Map(); // tabId -> { mint, protocol, pool, site }
const refreshTimers = new Map(); // mint -> timeout id

async function scheduleRefresh(mint, hint, delay = 0) {
  if (refreshTimers.has(mint)) return;
  refreshTimers.set(mint, setTimeout(async () => {
    refreshTimers.delete(mint);
    const kp = await vault.getKeypair();
    if (!kp) return;
    try { await market.refresh(mint, kp.publicKey, hint || {}); lastError.delete(mint); } catch (e) { lastError.set(mint, e.message); }
  }, delay));
}
const lastError = new Map();

// keep a fresh blockhash while any token page is open (no-feed sites like GMGN)
setInterval(() => { if (watch.size) trade.prefetchBlockhash().catch(() => {}); }, 15_000);

// periodic refresh for watched mints (state older than 12s)
setInterval(() => {
  for (const { mint, protocol, pool } of watch.values()) {
    const st = market.cached(mint);
    if (!st || Date.now() - st.at > 12_000) scheduleRefresh(mint, { protocol, pool });
  }
}, 4_000);

// ---------- trade log ----------
const MAX_TRADES = 20;
let logQueue = Promise.resolve();
// one entry per trade: a later confirm is merged into its send entry (serialized: get+set is not atomic)
function logTrade(entry) {
  logQueue = logQueue.then(async () => {
    const { trades = [] } = await chrome.storage.local.get('trades');
    const i = entry.confirm && entry.signature ? trades.findIndex((t) => t.signature === entry.signature && !t.confirm) : -1;
    if (i >= 0) trades[i] = { ...trades[i], confirm: entry.confirm };
    else trades.unshift({ ...entry, at: Date.now() });
    await chrome.storage.local.set({ trades: trades.slice(0, MAX_TRADES) });
  }).catch(() => {});
  return logQueue;
}

const pendingSigs = new Set();

// ---------- messages ----------
const SITE_RE = /^https:\/\/([a-z0-9-]+\.)?(axiom\.trade|gmgn\.ai)\//;
const fromSiteTab = (sender) => sender.tab && SITE_RE.test(sender.url || sender.tab.url || '');
const fromPopup = (sender) => !!sender.url && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    try {
      // --- from content scripts on supported terminals ---
      if (fromSiteTab(sender)) {
        const tabId = sender.tab.id;
        switch (msg.type) {
          case 'watch': {
            new PublicKey(msg.mint); // validate
            const first = !watch.size;
            watch.set(tabId, { mint: msg.mint, protocol: msg.protocol || null, pool: msg.pool || null, site: msg.site || null });
            if (msg.meta) tokenMeta.fromTerminal(msg.mint, msg.meta); else tokenMeta.ensure(msg.mint);
            scheduleRefresh(msg.mint, { protocol: msg.protocol || null, pool: msg.pool || null });
            if (first) trade.prefetchBlockhash().catch(() => {});
            return reply({ ok: true });
          }
          case 'unwatch': watch.delete(tabId); return reply({ ok: true });
          case 'feed:blockhash': trade.onFeedBlockhash(msg.hash); return reply({ ok: true });
          case 'feed:trade': {
            if (pendingSigs.has(msg.sig)) trade.resolveFromFeed(msg.sig);
            const w = watch.get(tabId);
            if (w && w.mint === msg.mint) scheduleRefresh(w.mint, { protocol: w.protocol, pool: w.pool }, 1_000); // debounced reserve refresh
            return reply({ ok: true });
          }
          case 'state': {
            const st = market.cached(msg.mint);
            const v = await vault.status();
            const cfg = await getConfig();
            const err = lastError.get(msg.mint) || null;
            return reply({ state: market.summary(st), error: err, friendly: err ? explain(err) : null, wallet: v, mode: cfg.mode });
          }
          case 'avgline': { // Tradeasy average buy price + current mid price, for the line on the terminal's chart
            const p = await positions.get(msg.mint);
            const st = market.cached(msg.mint);
            // only while Tradeasy still holds some of what it bought
            if (!p || !p.tradeSolIn || !(p.tokIn > 0) || !(p.tokIn - p.tokOut > p.tokIn * 1e-4) || !st) return reply({ line: null });
            const spot = await quote.spotPrice(st, market.summary(st).decimals).catch(() => null);
            return reply({ line: spot ? { avg: p.tradeSolIn / p.tokIn, spot, at: st.at } : null });
          }
          case 'quote': {
            const st = market.cached(msg.mint);
            if (!st) return reply({ error: 'no state' });
            return reply({ items: await quote.preview(st, market.summary(st).decimals, msg) });
          }
          case 'trade': {
            const res = await trade.execute(msg.req);
            const m = tokenMeta.get(res.mint);
            res.symbol = m && m.symbol ? m.symbol : null;
            if (res.simulated && !res.ok) res.friendly = explain(res.err, (res.logs || []).join('\n'));
            await logTrade({ ...res, logs: undefined });
            if (res.signature) {
              pendingSigs.add(res.signature);
              reply({ ok: true, result: res });
              // slot right after sending, to report how many slots it took to land
              const sentSlot = await market.connection().then((c) => c.getSlot('processed')).catch(() => null);
              const conf = await trade.confirm(res.signature);
              if (sentSlot && conf.slot) conf.slots = Math.max(0, conf.slot - sentSlot);
              pendingSigs.delete(res.signature);
              if (conf.status === 'failed') { const logs = await positions.txLogs(res.signature).catch(() => []); conf.friendly = explain(conf.err, logs.join('\n')); conf.logs = logs.slice(-8); }
              const kp = await vault.getKeypair();
              if (conf.status === 'confirmed' && kp) {
                const d = await positions.deltas(res.signature, res.mint, kp.publicKey.toBase58(), res.fees.tipLamports).catch(() => null);
                if (d) {
                  conf.actual = d;
                  const p = await positions.record(res.mint, res.side, d);
                  // fill price of this trade and the position's average entry price (SOL per token, fees excluded)
                  if (d.tokens) conf.price = { fill: d.tradeSol / Math.abs(d.tokens), avg: p.tokIn > 0 && p.tradeSolIn ? p.tradeSolIn / p.tokIn : null, buys: p.buys };
                }
              }
              await logTrade({ signature: res.signature, side: res.side, mint: res.mint, confirm: conf });
              chrome.tabs.sendMessage(tabId, { type: 'confirm', signature: res.signature, side: res.side, symbol: res.symbol, confirm: conf }).catch(() => {});
              if (kp) market.refresh(res.mint, kp.publicKey, { protocol: msg.req.protocol, pool: msg.req.pool }).catch(() => {});
              return;
            }
            return reply({ ok: true, result: res });
          }
        }
        return reply({ error: 'unknown message' });
      }

      // --- from popup ---
      if (fromPopup(sender)) {
        switch (msg.type) {
          case 'wallet:status': return reply(await vault.status());
          case 'wallet:create': return reply({ pubkey: await vault.create(msg.password, msg.secret || null) });
          case 'wallet:unlock': return reply({ pubkey: await vault.unlock(msg.password) });
          case 'wallet:lock': await vault.lock(); return reply({ ok: true });
          case 'wallet:reveal': return reply({ secret: await vault.reveal(msg.password) });
          case 'wallet:remove': await vault.remove(msg.password); return reply({ ok: true });
          case 'wallet:setPassword': return reply({ pubkey: await vault.setPassword(msg.oldPassword || null, msg.newPassword || null) });
          case 'wallet:balance': {
            const v = await vault.status();
            if (!v.pubkey) return reply({ sol: null });
            const c = await market.connection();
            return reply({ sol: (await c.getBalance(new PublicKey(v.pubkey))) / 1e9 });
          }
          case 'config:get': return reply(await getConfig());
          case 'config:set': return reply(await setConfig(msg.patch));
          case 'config:test': return reply(await testRpc());
          case 'trades:get': { const { trades = [] } = await chrome.storage.local.get('trades'); return reply(trades); }
          case 'wallet:sendPlan': {
            const p = await withdraw.plan(msg);
            return reply({ lamports: p.lamports, fee: withdraw.FEE_LAMPORTS, balance: p.bal, newAccount: p.newAccount, to: p.dest.toBase58() });
          }
          case 'wallet:send': {
            const r = await withdraw.send(msg);
            await logTrade({ side: 'withdraw', to: String(msg.to), sol: r.lamports / 1e9, signature: r.signature });
            const conf = await trade.confirm(r.signature, 60_000);
            await logTrade({ side: 'withdraw', signature: r.signature, confirm: conf });
            return reply({ signature: r.signature, sol: r.lamports / 1e9, confirm: conf });
          }
          case 'accounts:scan': return reply(await accounts.scan());
          case 'accounts:close': {
            const r = await accounts.closeAll(msg.accounts, (sig) => trade.confirm(sig, 60_000));
            if (r.signatures.length) await logTrade({ side: 'close', signature: r.signatures[0], count: r.closed, failed: r.failed, sol: r.lamports / 1e9 });
            return reply(r);
          }
          case 'watch:get': {
            const out = [];
            for (const [tabId, w] of watch) {
              const st = market.cached(w.mint);
              const p = await positions.get(w.mint);
              const value = p && st ? await quote.liquidationValue(st) : null;
              out.push({ ...w, tabId, meta: tokenMeta.get(w.mint), position: positions.pnl(p, value), state: market.summary(st), error: lastError.get(w.mint) || null, friendly: lastError.has(w.mint) ? explain(lastError.get(w.mint)) : null });
            }
            return reply(out);
          }
        }
        return reply({ error: 'unknown message' });
      }
      reply({ error: 'unauthorized sender' });
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      reply({ error: m, friendly: explain(m) });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => watch.delete(tabId));
