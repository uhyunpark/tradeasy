// Build -> verify -> sign -> simulate or send.
import {
  PublicKey, ComputeBudgetProgram, SystemProgram, SystemInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, MAYHEM_PROGRAM_ID,
  getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import { PUMP_AMM_SDK } from '@pump-fun/pump-sdk/swap';
import { NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { DAMM_V2_PROGRAM, DBC_PROGRAM, buildDammV2, buildDbc } from './meteora.js';
import { LAUNCHLAB_PROGRAM, CPMM_PROGRAM, buildLaunchLab, buildCpmm } from './raydium.js';
import { JUPITER_PROGRAM, buildJupiter } from './jupiter.js';
import { getConfig } from './config.js';
import { getKeypair } from './vault.js';
import * as market from './market.js';
import { quoteOut } from './quote.js';

// Helius Sender designated tip accounts (from helius-sdk SENDER_TIP_ACCOUNTS)
export const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];
const TIP_SET = new Set(SENDER_TIP_ACCOUNTS);
const MIN_TIP_SWQOS = 5_000;        // 0.000005 SOL
const MIN_TIP_MAX = 1_000_000;      // 0.001 SOL (Sender Max)
const SENDER_URL = 'https://sender.helius-rpc.com/fast';

const ALLOWED_PROGRAMS = new Set([
  ComputeBudgetProgram.programId, SystemProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, MAYHEM_PROGRAM_ID,
  DAMM_V2_PROGRAM, DBC_PROGRAM, LAUNCHLAB_PROGRAM, CPMM_PROGRAM, JUPITER_PROGRAM,
].map((p) => p.toBase58()));
// per-venue CU limit (simulated usage + headroom); the configured cuLimit is the floor
const VENUE_CU = { pump: 200_000, pumpswap: 200_000, meteora_damm_v2: 200_000, meteora_dbc: 250_000, raydium_launchlab: 200_000, raydium_cpmm: 200_000, jupiter: 400_000 };

// ---- blockhash from the terminal feed (fallback: RPC) ----
let feedBlockhash = null; // { hash, at } from the Axiom socket feed (GMGN has none: RPC prefetch)
let rpcBlockhash = null;  // { hash, at }  (prefetched; used on sites without a feed)
export function onFeedBlockhash(hash) {
  if (typeof hash === 'string' && hash.length >= 32 && hash.length <= 44) feedBlockhash = { hash, at: Date.now() };
}
export async function prefetchBlockhash() {
  if (feedBlockhash && Date.now() - feedBlockhash.at < 10_000) return;
  const c = await market.connection();
  const { blockhash } = await c.getLatestBlockhash('confirmed');
  rpcBlockhash = { hash: blockhash, at: Date.now() };
}
async function recentBlockhash() {
  if (feedBlockhash && Date.now() - feedBlockhash.at < 20_000) return { hash: feedBlockhash.hash, source: 'feed' };
  if (rpcBlockhash && Date.now() - rpcBlockhash.at < 40_000) return { hash: rpcBlockhash.hash, source: 'rpc-cached' };
  const c = await market.connection();
  const { blockhash } = await c.getLatestBlockhash('confirmed');
  rpcBlockhash = { hash: blockhash, at: Date.now() };
  return { hash: blockhash, source: 'rpc' };
}

const lamports = (sol) => Math.round(Number(sol) * 1e9);
const pctOf = (bn, pct) => bn.mul(new BN(Math.round(pct * 100))).div(new BN(10_000));

// Make sure the user's WSOL account is created/funded before and closed (unwrapped) after the swap,
// unless the SDK already did it. SyncNative = 17, CloseAccount = 9 (SPL Token instruction tags).
function withWsol(ixs, user, wrapLamports) {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, user, true);
  const isTok = (ix, tag) => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === tag && ix.keys[0].pubkey.equals(ata);
  const pre = [], post = [];
  if (!ixs.some((ix) => isTok(ix, 17))) {
    pre.push(createAssociatedTokenAccountIdempotentInstruction(user, ata, user, NATIVE_MINT));
    if (wrapLamports.gtn(0)) pre.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: ata, lamports: BigInt(wrapLamports.toString()) }), createSyncNativeInstruction(ata));
  }
  if (!ixs.some((ix) => isTok(ix, 9))) post.push(createCloseAccountInstruction(ata, user, user));
  return [...pre, ...ixs, ...post];
}

async function swapInstructions(st, user, req, slippage, opts = {}) {
  if (st.venue === 'jupiter') {
    const amount = req.side === 'buy' ? new BN(lamports(req.sol)) : pctOf(st.tokenBalance, req.percent);
    if (amount.lten(0)) throw new Error(req.side === 'buy' ? 'invalid buy amount' : 'no token balance to sell');
    const r = await buildJupiter({ mint: st.mint, user, side: req.side, amount, slippage, apiKey: opts.jupiterApiKey, maxAccounts: opts.maxAccounts });
    return { ixs: r.ixs, alts: r.alts, quote: { ...r.quote, via: st.quoteMint } };
  }
  if (st.venue === 'raydium_launchlab' || st.venue === 'raydium_cpmm') {
    const r = st.venue === 'raydium_launchlab' ? buildLaunchLab(st, user, req, slippage) : buildCpmm(st, user, req, slippage);
    return { ixs: withWsol(r.ixs, user, r.wrapLamports), quote: r.quote };
  }
  if (st.venue === 'meteora_damm_v2' || st.venue === 'meteora_dbc') {
    const c = await market.cacheConnection();
    const r = st.venue === 'meteora_damm_v2' ? await buildDammV2(c, st, user, req, slippage) : await buildDbc(c, st, user, req, slippage);
    return { ixs: r.ixs, quote: r.quote };
  }
  if (st.venue === 'pump') {
    const { global, feeConfig, bondingCurve, bondingCurveAccountInfo, associatedUserAccountInfo, tokenProgram } = st;
    const mint = new PublicKey(st.mint);
    if (req.side === 'buy') {
      // exact SOL in: spend exactly `spend` (fees included), at least quote * (1 - slippage) tokens
      const spend = new BN(lamports(req.sol));
      const amount = getBuyTokenAmountFromSolAmount({
        global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: spend, quoteMint: bondingCurve.quoteMint,
      });
      if (amount.lten(0)) throw new Error('quote returned 0 tokens');
      const ixs = await PUMP_SDK.buyInstructions({
        global, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo, mint, user, amount, solAmount: spend, slippage, tokenProgram,
      });
      const minOut = toExactIn(ixs, PUMP_PROGRAM_ID, PUMP_BUY_EXACT_SOL_IN, spend, slippage);
      return { ixs, quote: { tokensOut: amount.toString(), minTokensOut: minOut.toString(), spendLamports: spend.toString(), maxSolLamports: spend.toNumber() } };
    }
    const amount = pctOf(st.tokenBalance, req.percent);
    if (amount.lten(0)) throw new Error('no token balance to sell');
    const solAmount = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount });
    const ixs = await PUMP_SDK.sellInstructions({
      global, bondingCurveAccountInfo, bondingCurve, mint, user, amount, solAmount, slippage, tokenProgram,
      mayhemMode: bondingCurve.isMayhemMode, cashback: bondingCurve.isCashbackCoin,
    });
    return { ixs, quote: { tokensIn: amount.toString(), expectedSolLamports: solAmount.toString() } };
  }

  // PumpSwap, reversed pool (base = SOL, quote = token): buy token = sell base SOL, sell token = buy base SOL
  if (st.reversed) {
    if (req.side === 'buy') {
      const solIn = new BN(lamports(req.sol));
      const ixs = await PUMP_AMM_SDK.sellBaseInput(st.swapState, solIn, slippage);
      return { ixs: withWsol(ixs, user, solIn), quote: { spendLamports: solIn.toString(), reversedPool: true } };
    }
    const tokIn = pctOf(st.tokenBalance, req.percent);
    if (tokIn.lten(0)) throw new Error('no token balance to sell');
    const ixs = await PUMP_AMM_SDK.buyQuoteInput(st.swapState, tokIn, slippage);
    return { ixs: withWsol(ixs, user, new BN(0)), quote: { tokensIn: tokIn.toString(), reversedPool: true } };
  }

  // PumpSwap
  if (req.side === 'buy') {
    const quote = new BN(lamports(req.sol));
    const ixs = await PUMP_AMM_SDK.buyQuoteInput(st.swapState, quote, slippage);
    const minOut = toExactIn(ixs, PUMP_AMM_PROGRAM_ID, PUMP_AMM_BUY_EXACT_QUOTE_IN, quote, slippage);
    return { ixs, quote: { minTokensOut: minOut.toString(), spendLamports: quote.toString(), maxSolLamports: quote.toNumber() } };
  }
  const base = pctOf(st.tokenBalance, req.percent);
  if (base.lten(0)) throw new Error('no token balance to sell');
  const ixs = await PUMP_AMM_SDK.sellBaseInput(st.swapState, base, slippage);
  return { ixs, quote: { tokensIn: base.toString() } };
}

// Buys spend exactly the chosen SOL. The SDK builds the exact-out `buy` (tokens fixed, SOL up to +slippage);
// `buy_exact_sol_in` (pump) / `buy_exact_quote_in` (PumpSwap) take the same accounts and the same arg layout
// (u64, u64, then the same trailing options), so only the discriminator and the two amounts are swapped:
// (amount_out, max_in) -> (spend_in, min_out = amount_out * (1 - slippage)).
const BUY_DISC = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const PUMP_BUY_EXACT_SOL_IN = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);
const PUMP_AMM_BUY_EXACT_QUOTE_IN = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);
function toExactIn(ixs, programId, disc, spend, slippage) {
  const hits = ixs.filter((ix) => ix.programId.equals(programId) && ix.data.length >= 24 && ix.data.subarray(0, 8).equals(BUY_DISC));
  if (hits.length !== 1) throw new Error('unexpected buy instruction layout');
  const ix = hits[0];
  const amountOut = new BN(ix.data.subarray(8, 16), 'le');
  const minOut = amountOut.muln(Math.max(0, Math.round((100 - slippage) * 100))).divn(10_000);
  if (minOut.lten(0)) throw new Error('quote returned 0 tokens');
  const data = Buffer.from(ix.data);
  disc.copy(data, 0);
  spend.toArrayLike(Buffer, 'le', 8).copy(data, 8);
  minOut.toArrayLike(Buffer, 'le', 8).copy(data, 16);
  ix.data = data;
  return minOut;
}

// Reject anything we did not expect before the key ever touches it.
function verify(ixs, user, { maxOutflowLamports, wsolAta }) {
  let outflow = 0;
  for (const ix of ixs) {
    const pid = ix.programId.toBase58();
    if (!ALLOWED_PROGRAMS.has(pid)) throw new Error(`unexpected program ${pid}`);
    if (pid === SystemProgram.programId.toBase58()) {
      const type = SystemInstruction.decodeInstructionType(ix);
      if (type !== 'Transfer') throw new Error(`unexpected system instruction ${type}`);
      const { fromPubkey, toPubkey, lamports: l } = SystemInstruction.decodeTransfer(ix);
      if (!fromPubkey.equals(user)) throw new Error('transfer from unexpected account');
      const to = toPubkey.toBase58();
      if (!TIP_SET.has(to) && !(wsolAta && to === wsolAta)) throw new Error(`transfer to unexpected account ${to}`);
      outflow += Number(l);
    }
  }
  if (outflow > maxOutflowLamports) throw new Error(`SOL outflow ${outflow / 1e9} exceeds cap ${maxOutflowLamports / 1e9}`);
}

// Pure build + verify (no signing). Exported for the offline harness.
export async function buildIxs(st, user, req, preset, cfg) {
  const slippage = Number(preset.slippage);
  // fees: priority total = preset.priorityFeeSol over cuLimit; tip = preset.bribeFeeSol
  const cuLimit = Math.max(50_000, Math.min(1_400_000, Math.max(cfg.cuLimit | 0, VENUE_CU[st.venue] || 0)));
  const priorityLamports = lamports(preset.priorityFeeSol || 0);
  let tipLamports = lamports(preset.bribeFeeSol || 0);
  if (tipLamports < MIN_TIP_SWQOS) tipLamports = MIN_TIP_SWQOS; // Sender requires a tip
  const maxFee = lamports(preset.maxFeeSol || 0);
  if (maxFee > 0 && priorityLamports + tipLamports > maxFee) throw new Error('priority + tip exceeds preset max fee');
  const microLamports = Math.max(1, Math.floor((priorityLamports * 1e6) / cuLimit));

  const { ixs: swapIxs, quote, alts = [] } = await swapInstructions(st, user, req, slippage, { jupiterApiKey: cfg.jupiterApiKey, maxAccounts: cfg.maxAccounts });
  const tip = SystemProgram.transfer({
    fromPubkey: user, toPubkey: new PublicKey(SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)]), lamports: tipLamports,
  });
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...swapIxs,
    tip,
  ];

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true).toBase58();
  // buy may wrap/pay up to spend*(1+slippage); excess WSOL is unwrapped back. + rent headroom
  const maxOutflow = (req.side === 'buy' ? Math.ceil(lamports(req.sol) * (1 + slippage / 100)) : 0) + tipLamports + 10_000_000;
  verify(ixs, user, { maxOutflowLamports: maxOutflow, wsolAta });

  return { ixs, alts, quote, priorityLamports, tipLamports, microLamports, cuLimit };
}

export async function execute(req) {
  const t0 = Date.now();
  const cfg = await getConfig();
  const kp = await getKeypair();
  if (!kp) throw new Error('wallet is locked (popup > Unlock)');
  const user = kp.publicKey;
  // fill "auto"/missing preset fields with Tradeasy defaults
  const raw = req.preset || {};
  const filled = [];
  const fill = (k, d) => { if (raw[k] == null || raw[k] === '') { filled.push(`${k}=${d}`); return d; } return raw[k]; };
  const preset = {
    ...raw,
    slippage: fill('slippage', cfg.autoSlippage),
    priorityFeeSol: fill('priorityFeeSol', cfg.autoPriorityFeeSol),
    bribeFeeSol: fill('bribeFeeSol', cfg.autoTipSol),
  };
  const slippage = Number(preset.slippage);
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 100) throw new Error('invalid slippage in preset');
  if (req.side === 'buy') {
    const sol = Number(req.sol);
    if (!(sol > 0)) throw new Error('invalid buy amount');
    if (sol > cfg.maxSolPerTrade) throw new Error(`buy ${sol} SOL exceeds max per trade (${cfg.maxSolPerTrade})`);
  } else if (!(req.percent > 0 && req.percent <= 100)) throw new Error('invalid sell percent');

  // state: use cache if fresh, else refetch
  let st = market.cached(req.mint);
  if (!st || st.user !== user.toBase58() || Date.now() - st.at > 15_000) st = await market.refresh(req.mint, user, { protocol: req.protocol, pool: req.pool });
  const tState = Date.now();

  const bh = await recentBlockhash();
  const compile = async (c2) => {
    const b = await buildIxs(st, user, req, preset, c2);
    const m = new TransactionMessage({ payerKey: user, recentBlockhash: bh.hash, instructions: b.ixs }).compileToV0Message(b.alts);
    const t = new VersionedTransaction(m);
    t.sign([kp]);
    return { ...b, tx: t, size: t.serialize().length };
  };
  let built = await compile(cfg);
  if (built.size > 1232 && st.venue === 'jupiter') built = await compile({ ...cfg, maxAccounts: 28 }); // fewer route accounts
  const { tx, size, quote, priorityLamports, tipLamports, microLamports, cuLimit } = built;
  if (size > 1232) throw new Error(`transaction too large (${size} bytes)`);
  // human-readable expectation for the result toast
  let expected = null;
  try {
    const dec = market.summary(st).decimals;
    if (st.venue === 'jupiter') {
      expected = req.side === 'buy'
        ? { sol: Number(req.sol), tokens: Number(quote.outAmount) / 10 ** dec }
        : { tokens: Number(quote.inAmount) / 10 ** dec, sol: Number(quote.outAmount) / 1e9 };
    } else if (req.side === 'buy') {
      const inL = new BN(lamports(req.sol));
      expected = { sol: Number(req.sol), tokens: Number((await quoteOut(st, 'buy', inL)).toString()) / 10 ** dec };
    } else {
      const inT = pctOf(st.tokenBalance, req.percent);
      expected = { tokens: Number(inT.toString()) / 10 ** dec, sol: Number((await quoteOut(st, 'sell', inT)).toString()) / 1e9 };
    }
  } catch (_) {}

  const tBuilt = Date.now();

  const base = {
    side: req.side, mint: req.mint, venue: st.venue, mode: cfg.mode, quote, expected, percent: req.percent, size, slippage,
    fees: { priorityLamports, tipLamports, microLamports, cuLimit }, blockhashSource: bh.source,
    timing: { stateMs: tState - t0, buildMs: tBuilt - tState },
    warnings: [
      ...(preset.autoFee ? ['preset autoFee is on: using fixed priorityFeeSol from the preset'] : []),
      ...(raw.fromScreen && raw.fromScreen.length ? [`auto -> terminal on-screen value: ${raw.fromScreen.join(', ')}`] : []),
      ...(filled.length ? [`auto -> Tradeasy defaults: ${filled.join(', ')}`] : []),
      ...(tipLamports < MIN_TIP_MAX ? ['tip below 0.001 SOL: sent via Sender SWQoS-only path'] : []),
      ...(st.venue === 'jupiter' ? [`routed via Jupiter: ${(quote.route || []).join(' -> ')} (quote token ${st.quoteMint || '?'})`] : []),
    ],
  };

  const c = await market.connection();
  if (cfg.mode !== 'live') {
    const sim = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
    if (sim.value.err === 'AccountNotFound' && !(st.solBalance > 0)) base.warnings.push('wallet has no SOL: fund it first (the fee payer account does not exist yet)');
    return { ...base, simulated: true, ok: !sim.value.err, err: sim.value.err, unitsConsumed: sim.value.unitsConsumed,
      logs: (sim.value.logs || []).slice(-12), timing: { ...base.timing, simMs: Date.now() - tBuilt } };
  }

  // live: Helius Sender
  if (!(st.solBalance > 0)) throw new Error('wallet has no SOL: fund it first');
  const q = [];
  if (tipLamports < MIN_TIP_MAX) q.push('swqos_only=true');
  if (preset.mevProtection && !cfg.ignoreMev) q.push('mev-protect=true');
  if (cfg.heliusApiKey) q.push('api-key=' + encodeURIComponent(cfg.heliusApiKey)); // same Helius key: 50 req/s instead of 1
  const url = SENDER_URL + (q.length ? '?' + q.join('&') : '');
  const b64 = btoa(String.fromCharCode(...tx.serialize()));
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'sendTransaction', params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] });
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error('Sender: ' + (j.error.message || JSON.stringify(j.error)));
  const signature = j.result;
  rebroadcast(url, body, signature);
  return { ...base, simulated: false, signature, timing: { ...base.timing, sendMs: Date.now() - tBuilt } };
}

// Re-send the same signed tx a few times within ~1 s in case a packet was dropped. Same signature, so it can
// land at most once, and the min-out in the tx still bounds the price. Stops as soon as the tx is seen.
const REBROADCAST_MS = 300, REBROADCAST_TIMES = 3;
const seen = new Set(); // signatures seen on-chain (any status) or in the terminal feed
function rebroadcast(url, body, signature) {
  let n = 0;
  const tick = () => {
    if (seen.has(signature) || ++n > REBROADCAST_TIMES) return;
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {});
    setTimeout(tick, REBROADCAST_MS);
  };
  setTimeout(tick, REBROADCAST_MS);
}

// Poll for confirmation (feed detection can resolve earlier via resolveFromFeed).
const waiters = new Map();
export function resolveFromFeed(sig) { seen.add(sig); const w = waiters.get(sig); if (w) w('feed'); }
export async function confirm(signature, timeoutMs = 45_000) {
  const c = await market.connection();
  const start = Date.now();
  let viaFeed = false;
  const feed = new Promise((res) => waiters.set(signature, () => { viaFeed = true; res(); }));
  try {
    while (Date.now() - start < timeoutMs) {
      const { value } = await c.getSignatureStatuses([signature]);
      const s = value && value[0];
      if (s) seen.add(signature);
      if (s && s.err) return { status: 'failed', err: s.err, ms: Date.now() - start };
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { status: 'confirmed', ms: Date.now() - start, viaFeed, slot: s.slot };
      await Promise.race([feed, new Promise((r) => setTimeout(r, 800))]);
    }
    return { status: 'timeout', ms: Date.now() - start };
  } finally { waiters.delete(signature); setTimeout(() => seen.delete(signature), 5_000); }
}
