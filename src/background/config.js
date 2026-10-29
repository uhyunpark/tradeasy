import '../i18n-en.js';
import '../i18n.js';

const T = (k, v) => globalThis.TE_I18N.T(k, v);

export const DEFAULTS = {
  heliusApiKey: '',      // one Helius key: RPC (prefetch/simulate/confirm) + Sender (50 req/s instead of 1)
  customRpcUrl: '',      // optional override for the RPC only
  mode: 'simulate',      // 'simulate' | 'live'  (live must be switched on explicitly)
  maxSolPerTrade: 5,     // hard cap on SOL spent per buy
  cuLimit: 200000,       // compute unit limit (sims: ~105-115k); priority fee total = preset.priorityFeeSol
  ignoreMev: false,      // if preset.mevProtection is on and this is false, Sender mev-protect is used
  autoLockMin: 60,
  jupiterApiKey: '',     // optional; Jupiter routes non-SOL pairs (keyless: 0.5 req/s)
  // used when the terminal preset is "auto" (GMGN) or empty
  autoSlippage: 20,          // %
  autoPriorityFeeSol: 0.0003,
  autoTipSol: 0.001,         // >= 0.001 uses Sender Max (all paths)
};

export async function getConfig() {
  const got = await chrome.storage.local.get([...Object.keys(DEFAULTS), 'rpcUrl', 'senderApiKey']);
  // migrate v0.5 settings (full RPC URL + separate Sender key)
  if (!got.heliusApiKey && (got.rpcUrl || got.senderApiKey)) {
    const m = /[?&]api-key=([^&]+)/.exec(got.rpcUrl || '');
    if (m && /helius-rpc\.com/.test(got.rpcUrl)) got.heliusApiKey = decodeURIComponent(m[1]);
    else if (got.rpcUrl) got.customRpcUrl = got.rpcUrl;
    if (!got.heliusApiKey && got.senderApiKey) got.heliusApiKey = got.senderApiKey;
    await chrome.storage.local.set({ heliusApiKey: got.heliusApiKey || '', customRpcUrl: got.customRpcUrl || '' });
    await chrome.storage.local.remove(['rpcUrl', 'senderApiKey']);
  }
  const cfg = { ...DEFAULTS, ...got };
  delete cfg.senderApiKey;
  cfg.rpcUrl = cfg.customRpcUrl || (cfg.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(cfg.heliusApiKey)}` : '');
  return cfg;
}

export async function setConfig(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    if (k === 'mode' && v !== 'simulate' && v !== 'live') continue;
    if (typeof DEFAULTS[k] === 'number') { const n = Number(v); if (!Number.isFinite(n) || n < 0) continue; clean[k] = n; }
    else if (typeof DEFAULTS[k] === 'boolean') clean[k] = !!v;
    else clean[k] = String(v).trim();
  }
  if (clean.customRpcUrl && !/^https:\/\//.test(clean.customRpcUrl)) throw new Error('RPC URL must start with https://');
  if (clean.heliusApiKey && /[^A-Za-z0-9_-]/.test(clean.heliusApiKey)) {
    // allow pasting a full Helius URL: keep just the key
    const m = /api-key=([A-Za-z0-9_-]+)/.exec(clean.heliusApiKey);
    if (!m) throw new Error('invalid Helius API key');
    clean.heliusApiKey = m[1];
  }
  await chrome.storage.local.set(clean);
  return getConfig();
}

// checks that the configured RPC (Helius key) answers. Returns { ok, ms, slot } or { ok:false, error }.
export async function testRpc() {
  const cfg = await getConfig();
  if (!cfg.rpcUrl) return { ok: false, error: T('API key를 입력하세요') };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'processed' }] }), signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { ok: false, error: T('응답이 없습니다 (네트워크 확인)') };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: T('API key가 올바르지 않습니다') };
  if (res.status === 429) return { ok: false, error: T('요청 한도 초과 (잠시 후 다시)') };
  if (!res.ok) return { ok: false, error: T('RPC 오류 HTTP {status}', { status: res.status }) };
  let j = null; try { j = await res.json(); } catch (_) {}
  if (!j || typeof j.result !== 'number') return { ok: false, error: (j && j.error && j.error.message) || T('RPC 응답 형식 오류') };
  return { ok: true, ms: Date.now() - t0, slot: j.result };
}
