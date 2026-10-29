// Token name / symbol / image for the popup. Taken from the terminal's own API responses
// when available (Axiom token-and-best-pair-info, GMGN mutil_window_token_info);
// otherwise one Helius DAS getAsset call per mint (same API key).
import { getConfig } from './config.js';

const cache = new Map();   // mint -> { name, symbol, image, src }
const tried = new Map();   // mint -> last DAS attempt (ms)

export const get = (mint) => cache.get(mint) || null;

export function fromTerminal(mint, m) {
  const cur = cache.get(mint);
  if (cur && cur.src === 'terminal') return;
  cache.set(mint, { name: m.name || null, symbol: m.symbol || null, image: m.image || null, src: 'terminal' });
}

// many mints at once (settings: empty token accounts). One DAS getAssetBatch call.
export async function ensureMany(mints) {
  const ids = [...new Set(mints)].filter((m) => !cache.has(m) && Date.now() - (tried.get(m) || 0) > 60_000).slice(0, 1000);
  if (!ids.length) return;
  const { heliusApiKey } = await getConfig();
  if (!heliusApiKey) return;
  ids.forEach((m) => tried.set(m, Date.now()));
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids } }),
  });
  for (const a of (await r.json()).result || []) {
    if (!a || !a.id || cache.has(a.id)) continue;
    const md = (a.content && a.content.metadata) || {};
    const file = ((a.content && a.content.files) || [])[0] || {};
    const image = file.cdn_uri || (a.content && a.content.links && a.content.links.image) || null;
    cache.set(a.id, { name: md.name || null, symbol: md.symbol || (a.token_info && a.token_info.symbol) || null,
      image: typeof image === 'string' && /^https:\/\//.test(image) ? image : null, src: 'das' });
  }
}

export async function ensure(mint) {
  if (cache.has(mint)) return;
  const last = tried.get(mint) || 0;
  if (Date.now() - last < 60_000) return;
  tried.set(mint, Date.now());
  const { heliusApiKey } = await getConfig();
  if (!heliusApiKey) { tried.delete(mint); return; }
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
    });
    const a = (await r.json()).result;
    if (!a || cache.has(mint)) return;
    const md = (a.content && a.content.metadata) || {};
    const file = ((a.content && a.content.files) || [])[0] || {};
    const image = file.cdn_uri || (a.content && a.content.links && a.content.links.image) || null;
    cache.set(mint, { name: md.name || null, symbol: md.symbol || (a.token_info && a.token_info.symbol) || null,
      image: typeof image === 'string' && /^https:\/\//.test(image) ? image : null, src: 'das' });
  } catch (_) { /* retried after 60s */ }
}
