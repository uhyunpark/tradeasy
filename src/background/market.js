// On-chain state per token, prefetched on page entry and refreshed on trade
// activity, so that a click only needs to build + sign (no RPC on the hot path).
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount, unpackMint, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { OnlinePumpSdk, canonicalPumpPoolPda, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { DAMM_V2_PROGRAM, DBC_PROGRAM, loadDammV2, loadDbc } from './meteora.js';
import { LAUNCHLAB_PROGRAM, CPMM_PROGRAM, launchLabPoolOf, loadLaunchLab, loadCpmm } from './raydium.js';
import { OnlinePumpAmmSdk } from '@pump-fun/pump-sdk/swap';
import { getConfig } from './config.js';
import * as tokenMeta from './meta.js';

// Two connections over one RPC cache:
//  - live:  always hits the RPC and stores account/slot reads (used for prefetch)
//  - cache: serves those reads from the cache when present (used at click time)
// This lets venue SDKs that read accounts while building a tx run with zero RPC on a warm cache.
const CACHEABLE = new Set(['getAccountInfo', 'getMultipleAccounts', 'getSlot', 'getBlockTime', 'getEpochInfo', 'getMinimumBalanceForRentExemption']);
const rpcCache = new Map(); // method+args -> { at, value }
function withCache(c, mode) {
  const orig = c._rpcRequest.bind(c);
  c._rpcRequest = async (method, args) => {
    if (!CACHEABLE.has(method)) return orig(method, args);
    const key = method + JSON.stringify(args);
    if (mode === 'cache') {
      if (method === 'getBlockTime') return { jsonrpc: '2.0', id: 0, result: Math.floor(Date.now() / 1000) };
      const hit = rpcCache.get(key);
      if (hit && Date.now() - hit.at < 60_000) {
        if (method === 'getSlot' && typeof hit.value.result === 'number') return { ...hit.value, result: hit.value.result + Math.floor((Date.now() - hit.at) / 400) };
        return hit.value;
      }
    }
    const value = await orig(method, args);
    if (value && !value.error) rpcCache.set(key, { at: Date.now(), value });
    return value;
  };
  return c;
}

let conn = null, cacheConn = null, connUrl = null, bcSdk = null, ammSdk = null;
export async function connection() {
  const { rpcUrl } = await getConfig();
  if (!rpcUrl) throw new Error('Helius API key is not set (DX popup)');
  if (!conn || connUrl !== rpcUrl) {
    conn = withCache(new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true }), 'live');
    cacheConn = withCache(new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true }), 'cache');
    connUrl = rpcUrl;
    rpcCache.clear();
    bcSdk = new OnlinePumpSdk(conn);
    ammSdk = new OnlinePumpAmmSdk(conn);
  }
  return conn;
}
export async function cacheConnection() { await connection(); return cacheConn; }

const isSolQuote = (q) => !q || q.equals(PublicKey.default) || q.equals(NATIVE_MINT);

// ---- slow-changing program config, cached ----
let bcGlobal = null; // { global, feeConfig, at }
async function bondingGlobals() {
  if (bcGlobal && Date.now() - bcGlobal.at < 5 * 60_000) return bcGlobal;
  await connection();
  const [global, feeConfig] = await Promise.all([bcSdk.fetchGlobal(), bcSdk.fetchFeeConfig().catch(() => null)]);
  bcGlobal = { global, feeConfig, at: Date.now() };
  return bcGlobal;
}

const tokenProgramCache = new Map();
const decimalsCache = new Map();
async function tokenProgramOf(mint) {
  const k = mint.toBase58();
  if (tokenProgramCache.has(k)) return tokenProgramCache.get(k);
  const c = await connection();
  const info = await c.getAccountInfo(mint);
  if (!info) throw new Error('mint account not found');
  const owner = info.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('unknown token program');
  let decimals = 6;
  try { decimals = unpackMint(mint, info, owner).decimals; } catch (_) {}
  tokenProgramCache.set(k, owner);
  decimalsCache.set(k, decimals);
  return owner;
}

function tokenAmount(accountInfo, address, program) {
  if (!accountInfo) return new BN(0);
  try { return new BN(unpackAccount(address, accountInfo, program).amount.toString()); } catch (_) { return new BN(0); }
}

// ---- per-mint state ----
const states = new Map(); // mint -> { venue, ..., at }
const inflight = new Map();

const SUPPORTED = 'supported: pump.fun, PumpSwap, Meteora DBC, Meteora DAMM v2, Raydium LaunchLab, Raydium CPMM';

// LaunchLab curve; once it has graduated to CPMM, the CPMM pool instead
async function loadLaunchLabFollowing(c, poolKey, mint, user) {
  const ll = await loadLaunchLab(c, poolKey, mint, user);
  if (ll.status === 0 || !ll.migratedPool) return ll; // trading, or AMM v4 target (build reports it)
  const tinfo = await c.getAccountInfo(ll.migratedPool);
  if (tinfo && tinfo.owner.equals(CPMM_PROGRAM)) { const cp = await loadCpmm(c, ll.migratedPool, mint, user); cp.graduatedFrom = 'raydium_launchlab'; return cp; }
  return ll; // complete, migration pending: build reports "waiting for migration"
}
async function tryLaunchLab(c, mint, user) {
  const key = launchLabPoolOf(mint);
  const info = await c.getAccountInfo(key);
  return info && info.owner.equals(LAUNCHLAB_PROGRAM) ? loadLaunchLabFollowing(c, key, mint, user) : null;
}

export function cached(mint) { return states.get(mint) || null; }

export async function refresh(mintStr, user, hint = {}) {
  if (inflight.has(mintStr)) return inflight.get(mintStr);
  const p = (async () => {
    const mint = new PublicKey(mintStr);
    const c = await connection();
    const keep = async (vst) => {
      const d = vst.decimals != null ? vst.decimals : vst.base ? vst.base.mint.decimals : vst.a ? (vst.a.mint.address.equals(mint) ? vst.a.mint.decimals : vst.b.mint.decimals) : null;
      if (d != null) decimalsCache.set(mintStr, d); // pump / PumpSwap decimals come from tokenProgramOf()
      vst.solBalance = await c.getBalance(user, 'confirmed');
      vst.user = user.toBase58();
      vst.at = Date.now();
      states.set(mintStr, vst);
      return vst;
    };
    // 1) the terminal told us the pool: identify the venue by the pool account's owner program
    let poolKey = null, hintedAmmPool = null;
    try { if (hint.pool) poolKey = new PublicKey(hint.pool); } catch (_) {}
    if (poolKey) {
      const info = await c.getAccountInfo(poolKey);
      const owner = info && info.owner;
      if (owner && owner.equals(PUMP_AMM_PROGRAM_ID)) hintedAmmPool = poolKey; // may be a non-canonical PumpSwap pool
      let vst = null;
      if (owner && owner.equals(DAMM_V2_PROGRAM)) vst = await loadDammV2(c, poolKey, mint, user);
      else if (owner && owner.equals(DBC_PROGRAM)) {
        vst = await loadDbc(c, poolKey, mint, user);
        if (vst.migrated || vst.completed) {
          // graduated (or graduating): follow the curve into its DAMM v2 pool once it exists
          const target = vst.migratedPool;
          const tinfo = target ? await c.getAccountInfo(target) : null;
          if (tinfo && tinfo.owner.equals(DAMM_V2_PROGRAM)) {
            vst = await loadDammV2(c, target, mint, user);
            vst.graduatedFrom = 'meteora_dbc';
          } else if (vst.migrated) {
            throw new Error('DBC curve has graduated and its new pool was not found: reload the page');
          } // completed but not migrated yet: keep the DBC state; build reports "waiting for migration"
        }
      } else if (owner && owner.equals(LAUNCHLAB_PROGRAM)) vst = await loadLaunchLabFollowing(c, poolKey, mint, user);
      else if (owner && owner.equals(CPMM_PROGRAM)) vst = await loadCpmm(c, poolKey, mint, user);
      else if (info && !owner.equals(PUMP_PROGRAM_ID) && !owner.equals(PUMP_AMM_PROGRAM_ID)) {
        throw new Error(`unsupported venue: ${hint.protocol || owner.toBase58()} (${SUPPORTED})`);
      }
      if (vst) return keep(vst);
    } else if (hint.protocol && /meteora|raydium|orca|launchlab|launchpad|bonk|moonshot|dlmm|cpmm|clmm|whirlpool/i.test(hint.protocol) && !/damm|dbc|dynamic.?bonding|amm v2/i.test(hint.protocol)) {
      // no pool address from the terminal: a LaunchLab curve can still be derived from the mint
      const vst = await tryLaunchLab(c, mint, user);
      if (vst) return keep(vst);
      throw new Error(`unsupported venue: ${hint.protocol} (${SUPPORTED})`);
    }
    // 2) pump.fun / PumpSwap: addresses derived from the mint
    const tokenProgram = await tokenProgramOf(mint);
    const wantAmm = !!hintedAmmPool || /^(Pump AMM|pump_?amm|pumpswap)$/i.test(hint.protocol || '');
    let st;

    if (!wantAmm) {
      const { global, feeConfig } = await bondingGlobals();
      let buyState = null;
      try { buyState = await bcSdk.fetchBuyState(mint, user, tokenProgram); } catch (e) {
        if (!/Bonding curve account not found/.test(e.message)) throw e; // not a pump.fun coin: try PumpSwap below
      }
      if (buyState && !buyState.bondingCurve.complete) {
        if (!isSolQuote(buyState.bondingCurve.quoteMint)) { tokenMeta.ensure(buyState.bondingCurve.quoteMint.toBase58()); }
        if (!isSolQuote(buyState.bondingCurve.quoteMint)) throw new Error(`only SOL-quoted coins are supported (quote ${buyState.bondingCurve.quoteMint.toBase58()})`);
        const ata = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
        st = {
          venue: 'pump', mint: mintStr, tokenProgram, global, feeConfig, ...buyState,
          tokenBalance: tokenAmount(buyState.associatedUserAccountInfo, ata, tokenProgram),
        };
      }
    }
    if (!st) {
      // PumpSwap: the pool the terminal reported (owner already verified), else the canonical pool for the mint.
      // Some coins trade in a non-canonical PumpSwap pool (e.g. launched straight into the AMM).
      const candidates = [hintedAmmPool, canonicalPumpPoolPda(mint)].filter(Boolean);
      let swapState = null, lastErr = null;
      for (const pk of candidates) {
        try { swapState = await ammSdk.swapSolanaState(pk, user); break; } catch (e) { lastErr = lastErr || e; } // keep the hinted pool's error
      }
      if (!swapState) {
        if (lastErr && /Pool account not found/.test(lastErr.message)) {
          const vst = await tryLaunchLab(c, mint, user);
          if (vst) return keep(vst);
          throw new Error(`unsupported venue: the terminal did not provide a supported pool (${SUPPORTED})`);
        }
        throw lastErr;
      }
      // normal pool: base = token, quote = SOL. Reversed pool (user-created): base = SOL, quote = token.
      const reversed = swapState.baseMint.equals(NATIVE_MINT) && swapState.pool.quoteMint.equals(mint);
      if (!reversed) {
        if (!swapState.baseMint.equals(mint)) throw new Error('pool does not contain this token');
        if (!isSolQuote(swapState.pool.quoteMint)) { tokenMeta.ensure(swapState.pool.quoteMint.toBase58()); }
        if (!isSolQuote(swapState.pool.quoteMint)) throw new Error(`only SOL-paired pools are supported (quote ${swapState.pool.quoteMint.toBase58()})`);
      }
      st = {
        venue: 'pumpswap', mint: mintStr, tokenProgram, swapState, reversed,
        tokenBalance: reversed
          ? tokenAmount(swapState.userQuoteAccountInfo, swapState.userQuoteTokenAccount, swapState.quoteTokenProgram)
          : tokenAmount(swapState.userBaseAccountInfo, swapState.userBaseTokenAccount, swapState.baseTokenProgram),
      };
    }
    return keep(st);
  })().finally(() => inflight.delete(mintStr));
  inflight.set(mintStr, p);
  return p;
}

export function summary(st) {
  if (!st) return null;
  const decimals = decimalsCache.get(st.mint) ?? 6;
  const raw = st.tokenBalance.toString();
  const tokenBalance = Number(raw) / 10 ** decimals;
  const base = { venue: st.venue, mint: st.mint, at: st.at, solBalance: st.solBalance / 1e9, tokenBalanceRaw: raw, tokenBalance, decimals };
  if (st.venue === 'pump') {
    return { ...base, complete: st.bondingCurve.complete, mayhem: st.bondingCurve.isMayhemMode, cashback: st.bondingCurve.isCashbackCoin,
      virtualSol: st.bondingCurve.virtualQuoteReserves?.toString?.(), virtualToken: st.bondingCurve.virtualTokenReserves.toString() };
  }
  if (st.venue === 'pumpswap') return { ...base, pool: st.swapState.poolKey.toBase58(), reversed: !!st.reversed, baseReserve: st.swapState.poolBaseAmount.toString(), quoteReserve: st.swapState.poolQuoteAmount.toString() };
  return { ...base, pool: st.poolKey.toBase58() };
}
