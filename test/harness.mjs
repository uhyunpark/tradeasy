// Offline harness: runs the real background modules (market + trade) against a
// local fake RPC served from fixtures captured from mainnet. Records missing keys.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const FIX = 'test/fixtures.json'; // run from the project root
const fixtures = existsSync(FIX) ? JSON.parse(readFileSync(FIX, 'utf8')) : {};
const missing = new Set();
const calls = [];

// ---- chrome mock ----
const mem = { local: {}, session: {} };
const area = (name) => ({
  async get(keys) {
    const s = mem[name];
    if (keys == null) return { ...s };
    const ks = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
    const o = {}; for (const k of ks) if (k in s) o[k] = s[k]; return o;
  },
  async set(obj) { Object.assign(mem[name], obj); },
  async remove(keys) { for (const k of [].concat(keys)) delete mem[name][k]; },
});
globalThis.chrome = { storage: { local: area('local'), session: area('session') }, runtime: { id: 'test' } };

// ---- fake RPC ----
const acc = (k) => {
  const f = fixtures[k];
  if (f === undefined) { missing.add(k); return null; }
  return f; // null or {data:[b64,'base64'], owner, lamports, executable, rentEpoch, space}
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const reqs = JSON.parse(body);
    const one = (r) => {
      calls.push(r.method);
      const ctx = { context: { slot: 1, apiVersion: '2.0.0' } };
      switch (r.method) {
        case 'getMultipleAccounts': return { ...ctx, value: r.params[0].map(acc) };
        case 'getAccountInfo': return { ...ctx, value: acc(r.params[0]) };
        case 'getBalance': return { ...ctx, value: 5_000_000_000 };
        case 'getSlot': return 462200000;
        case 'getBlockTime': return Math.floor(Date.now() / 1000);
        case 'getLatestBlockhash': return { ...ctx, value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 1 } };
        case 'getEpochInfo': return { epoch: 900, slotIndex: 1, slotsInEpoch: 432000, absoluteSlot: 1, blockHeight: 1 };
        case 'simulateTransaction': return { ...ctx, value: { err: null, logs: ['fake sim'], unitsConsumed: 1, accounts: null } };
        default: return { __err: 'unsupported ' + r.method };
      }
    };
    const wrap = (r) => { const out = one(r); return out && out.__err ? { jsonrpc: '2.0', id: r.id, error: { code: -1, message: out.__err } } : { jsonrpc: '2.0', id: r.id, result: out }; };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(wrap) : wrap(reqs)));
  });
});
(async () => {
await new Promise((r) => server.listen(8899, r));

const { Keypair } = await import('@solana/web3.js');
const market = await import('../src/background/market.js');
const trade = await import('../src/background/trade.js');
const vault = await import('../src/background/vault.js');
const quote = await import('../src/background/quote.js');

mem.local.customRpcUrl = 'http://127.0.0.1:8899';
mem.local.mode = 'simulate';
mem.local.maxSolPerTrade = 1;
const user = Keypair.fromSeed(new Uint8Array(32).fill(7));
await vault.create('testpassword', JSON.stringify([...user.secretKey]));

const cases = JSON.parse(readFileSync(process.argv[2] || 'test/cases.json', 'utf8'));
// give the test user a token balance so sells can be built
const spl = await import('@solana/spl-token');
const { PublicKey } = await import('@solana/web3.js');
for (const c of cases) {
  for (const prog of [spl.TOKEN_PROGRAM_ID, spl.TOKEN_2022_PROGRAM_ID]) {
    const mint = new PublicKey(c.mint);
    const ata = spl.getAssociatedTokenAddressSync(mint, user.publicKey, true, prog);
    const data = Buffer.alloc(spl.ACCOUNT_SIZE);
    spl.AccountLayout.encode({ mint, owner: user.publicKey, amount: 1_000_000_000_000n, delegateOption: 0, delegate: PublicKey.default,
      state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    fixtures[ata.toBase58()] = { data: [data.toString('base64'), 'base64'], owner: prog.toBase58(), lamports: 2039280, executable: false, rentEpoch: 0, space: data.length };
  }
}
const preset = { slippage: '30', priorityFeeSol: '0.00025', bribeFeeSol: '0.0001', maxFeeSol: '0.1', autoFee: false, mevProtection: false };
const results = [];
for (const c of cases) {
  try {
    const st = await market.refresh(c.mint, user.publicKey, { protocol: c.protocol, pool: c.pool });
    const r = { mint: c.mint, venue: st.venue, summary: market.summary(st) };
    for (const req of c.reqs) {
      try {
        const out = await trade.execute({ ...req, mint: c.mint, protocol: c.protocol, preset });
        r[req.side + (req.sol || req.percent)] = { ok: out.ok, size: out.size, expected: out.expected, quote: out.quote, warnings: out.warnings, fees: out.fees };
      } catch (e) { r[req.side + (req.sol || req.percent)] = { error: e.message }; }
    }
    const dec = market.summary(st).decimals;
    r.previewBuy = await quote.preview(st, dec, { side: 'buy', sols: [0.01, 0.5, 5] }).catch((e) => e.message);
    r.previewSell = await quote.preview(st, dec, { side: 'sell', pcts: [25, 100] }).catch((e) => e.message);
    r.liq = await quote.liquidationValue(st);
    results.push(r);
  } catch (e) { results.push({ mint: c.mint, error: e.message, stack: e.stack.split('\n').slice(0, 3).join(' | ') }); }
}
// Jupiter route (non-SOL quote): mocked /swap/v2/build response, real buildIxs + verify + v0 compile with a lookup table
{
  const { SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
  const BN = (await import('bn.js')).default;
  const mint = new PublicKey('5DAqRe7Fa7SzVN3urM8hqKfmCUwZvowZTvp5WMgupump');
  const wsol = spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, user.publicKey, true);
  const J = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString('base64') });
  const altKeys = Array.from({ length: 30 }, () => Keypair.generate().publicKey);
  const swap = new TransactionInstruction({ programId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }, ...altKeys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))], data: Buffer.alloc(24) });
  const body = (buy) => ({
    inAmount: buy ? '10000000' : '500000000000', outAmount: buy ? '36000000000' : '9000000', otherAmountThreshold: '1', priceImpactPct: '0.01',
    routePlan: [{ swapInfo: { label: 'Raydium CLMM' } }, { swapInfo: { label: 'Pump.fun Amm' } }],
    setupInstructions: [J(spl.createAssociatedTokenAccountIdempotentInstruction(user.publicKey, wsol, user.publicKey, spl.NATIVE_MINT)),
      ...(buy ? [J(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: wsol, lamports: 10_000_000 })), J(spl.createSyncNativeInstruction(wsol))] : [])],
    swapInstruction: J(swap), cleanupInstruction: J(spl.createCloseAccountInstruction(wsol, user.publicKey, user.publicKey)), otherInstructions: [],
    addressesByLookupTableAddress: { [Keypair.generate().publicKey.toBase58()]: altKeys.map((k) => k.toBase58()) },
  });
  const realFetch = globalThis.fetch; let jupUrl = null;
  globalThis.fetch = async (url, opts) => { if (String(url).startsWith('https://api.jup.ag/')) { jupUrl = String(url); return new Response(JSON.stringify(body(/inputMint=So111/.test(jupUrl))), { status: 200 }); } return realFetch(url, opts); };
  const st = { venue: 'jupiter', mint: mint.toBase58(), quoteMint: '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g', tokenBalance: new BN('1000000000000'), tokenProgram: spl.TOKEN_PROGRAM_ID };
  const jr = {};
  for (const req of [{ side: 'buy', sol: 0.01 }, { side: 'sell', percent: 50 }]) {
    try {
      const b = await trade.buildIxs(st, user.publicKey, req, preset, { cuLimit: 200000 });
      const m = new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: b.ixs }).compileToV0Message(b.alts);
      jr[req.side] = { ok: true, ixs: b.ixs.length, alts: b.alts.length, cuLimit: b.cuLimit, size: new VersionedTransaction(m).serialize().length, route: b.quote.route, url: jupUrl.replace(/taker=\w+/, 'taker=…') };
    } catch (e) { jr[req.side] = { error: e.message }; }
  }
  globalThis.fetch = realFetch;
  results.push({ jupiter: jr });
}
console.log(JSON.stringify({ results, missing: [...missing], calls: [...new Set(calls)] }, null, 2));
server.close();
process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
