// Tradeasy-wallet positions per mint, from confirmed live trades only (simulations never count).
// Amounts come from the confirmed transaction itself (balance deltas), so fees, tip and
// account rent are included in the cost.
import { getConfig } from './config.js';

export async function all() {
  const { positions = {} } = await chrome.storage.local.get('positions');
  return positions;
}
export async function get(mint) { return (await all())[mint] || null; }

// returns { sol, tokens, tradeSol } or null when the tx cannot be read yet.
//  sol      wallet SOL change incl. network fee, tip and new-account rent (sol < 0 = spent)
//  tradeSol SOL that actually went to / came from the pool (fees, tip and rent removed), for the fill price
export async function deltas(signature, mint, owner, tipLamports = 0) {
  const { rpcUrl } = await getConfig();
  for (let i = 0; i < 6; i++) {
    let tx = null;
    try {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }) });
      tx = (await r.json()).result;
    } catch (_) {}
    if (tx && tx.meta) {
      if (tx.meta.err) return null;
      const keys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
      const idx = keys.indexOf(owner);
      const sol = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9 : 0;
      const amt = (arr) => (arr || []).filter((b) => b.mint === mint && b.owner === owner)
        .reduce((s, b) => s + Number(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || 0), 0);
      // rent paid for accounts created by this tx (e.g. the token ATA on a first buy); temp accounts closed in the tx net to 0
      let rent = 0;
      keys.forEach((k, i) => { if (i !== idx && tx.meta.preBalances[i] === 0 && tx.meta.postBalances[i] > 0) rent += tx.meta.postBalances[i]; });
      const overhead = (tx.meta.fee + tipLamports + rent) / 1e9;
      return { sol, tokens: amt(tx.meta.postTokenBalances) - amt(tx.meta.preTokenBalances), tradeSol: Math.abs(sol + overhead) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

export async function record(mint, side, d) {
  const positions = await all();
  const p = positions[mint] || { solIn: 0, solOut: 0, tokIn: 0, tokOut: 0, buys: 0, sells: 0, firstAt: Date.now() };
  if (side === 'buy') {
    p.solIn += Math.max(0, -d.sol); p.tokIn += Math.max(0, d.tokens); p.buys++;
    p.tradeSolIn = (p.tradeSolIn || 0) + (d.tradeSol || 0); // cost without fees/rent: average entry price
  }
  else { p.solOut += Math.max(0, d.sol); p.tokOut += Math.max(0, -d.tokens); p.sells++; }
  p.lastAt = Date.now();
  positions[mint] = p;
  await chrome.storage.local.set({ positions });
  return p;
}

// realized + unrealized PnL in SOL. value = SOL you would get selling the current Tradeasy balance now.
export function pnl(p, value) {
  if (!p || !(p.solIn > 0)) return null;
  const v = value == null ? null : value;
  const total = v == null ? null : p.solOut + v - p.solIn;
  return { invested: p.solIn, returned: p.solOut, value: v, pnl: total, pnlPct: total == null ? null : (total / p.solIn) * 100,
    avgPrice: p.tokIn > 0 && p.tradeSolIn ? p.tradeSolIn / p.tokIn : null, buys: p.buys };
}

// program logs of a landed tx (used to explain on-chain failures)
export async function txLogs(signature) {
  const { rpcUrl } = await getConfig();
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }) });
      const tx = (await r.json()).result;
      if (tx && tx.meta) return tx.meta.logMessages || [];
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}
