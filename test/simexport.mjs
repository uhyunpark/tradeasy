// Build unsigned txs for a funded payer (sigVerify:false simulation on mainnet via the browser tab).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
const FIX = 'test/fixtures.json'; // run from the project root
const fixtures = existsSync(FIX) ? JSON.parse(readFileSync(FIX, 'utf8')) : {};
const missing = new Set();
const SLOT = Number(process.env.SLOT || 462200000);
const mem = { local: {}, session: {} };
const area = (n) => ({ async get(k) { const s = mem[n]; const ks = k == null ? Object.keys(s) : [].concat(typeof k === 'object' && !Array.isArray(k) ? Object.keys(k) : k); const o = {}; for (const x of ks) if (x in s) o[x] = s[x]; return o; }, async set(o) { Object.assign(mem[n], o); }, async remove(k) { for (const x of [].concat(k)) delete mem[n][x]; } });
globalThis.chrome = { storage: { local: area('local'), session: area('session') }, runtime: { id: 't' } };
const acc = (k) => { const f = fixtures[k]; if (f === undefined) { missing.add(k); return null; } return f; };
const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  const r = JSON.parse(b); const ctx = { context: { slot: 1 } }; let result;
  if (r.method === 'getMultipleAccounts') result = { ...ctx, value: r.params[0].map(acc) };
  else if (r.method === 'getAccountInfo') result = { ...ctx, value: acc(r.params[0]) };
  else if (r.method === 'getBalance') result = { ...ctx, value: 5e9 };
  else if (r.method === 'getSlot') result = SLOT;
  else if (r.method === 'getBlockTime') result = Math.floor(Date.now() / 1000);
  else result = null;
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
}); });
(async () => {
  await new Promise((r) => server.listen(8898, r));
  const { PublicKey, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
  const market = await import('../src/background/market.js');
  const trade = await import('../src/background/trade.js');
  mem.local.customRpcUrl = 'http://127.0.0.1:8898';
  const payer = new PublicKey(process.argv[2]);
  const cases = JSON.parse(readFileSync(process.argv[3] || 'test/cases.json', 'utf8'));
  const preset = { slippage: process.env.SLIP || '30', priorityFeeSol: '0.00025', bribeFeeSol: '0.0001', maxFeeSol: '0.1' };
  const out = [];
  for (const c of cases) {
    try {
      const st = await market.refresh(c.mint, payer, { protocol: c.protocol, pool: c.pool });
      for (const req of c.reqs) {
        const { ixs } = await trade.buildIxs(st, payer, req, preset, { cuLimit: 200000 });
        const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message();
        const tx = new VersionedTransaction(msg);
        out.push({ mint: c.mint.slice(0, 6), venue: st.venue, req, tx: Buffer.from(tx.serialize()).toString('base64') });
      }
    } catch (e) { out.push({ mint: c.mint.slice(0, 6), error: e.message }); }
  }
  console.log(JSON.stringify({ out, missing: [...missing] }));
  server.close(); process.exit(0);
})();
