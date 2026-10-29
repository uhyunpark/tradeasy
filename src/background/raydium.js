// Raydium venues: LaunchLab (bonding curve, e.g. bonk.fun) and CPMM (constant product, LaunchLab's
// graduation target). Same contract as meteora.js:
//   load*()  at page entry through the LIVE connection (warms the RPC cache)
//   build*() / quote*() at click time from the loaded state only (no RPC)
import { PublicKey } from '@solana/web3.js';
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  unpackMint, unpackAccount,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  LaunchpadPool, LaunchpadConfig, PlatformConfig, Curve, buyExactInInstruction, sellExactInInstruction,
  getPdaLaunchpadAuth, getPdaLaunchpadPoolId, getPdaPlatformVault, getPdaCreatorVault,
} from '@raydium-io/raydium-sdk-v2/lib/raydium/launchpad/index.mjs';
import {
  CpmmPoolInfoLayout, CpmmConfigInfoLayout, CurveCalculator, makeSwapCpmmBaseInInstruction, getPdaPoolAuthority, getCpmmPdaPoolId,
} from '@raydium-io/raydium-sdk-v2/lib/raydium/cpmm/index.mjs';

export const LAUNCHLAB_PROGRAM = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
export const CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

const lamports = (sol) => Math.round(Number(sol) * 1e9);
const pctOf = (bn, pct) => bn.mul(new BN(Math.round(pct * 100))).div(new BN(10_000));
const minOut = (out, slippage) => out.mul(new BN(10_000 - Math.min(9_999, Math.round(slippage * 100)))).div(new BN(10_000));
const ZERO = new BN(0);

async function mintInfo(conn, mint) {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return { program: info.owner, decimals: unpackMint(mint, info, info.owner).decimals };
}
async function balanceOf(conn, mint, owner, program) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
  const info = await conn.getAccountInfo(ata);
  if (!info) return new BN(0);
  try { return new BN(unpackAccount(ata, info, program).amount.toString()); } catch (_) { return new BN(0); }
}
const tokenAta = (st, user) => getAssociatedTokenAddressSync(new PublicKey(st.mint), user, true, st.tokenProgram);
const createTokenAta = (st, user) => createAssociatedTokenAccountIdempotentInstruction(user, tokenAta(st, user), user, new PublicKey(st.mint), st.tokenProgram);
const wsolAta = (user) => getAssociatedTokenAddressSync(NATIVE_MINT, user, true);

// ---------------- LaunchLab ----------------
export const launchLabPoolOf = (mint) => getPdaLaunchpadPoolId(LAUNCHLAB_PROGRAM, mint, NATIVE_MINT).publicKey;

// pool status: 0 trading on the curve, 1 curve complete (migration pending), 2 migrated
export async function loadLaunchLab(conn, poolKey, mint, user) {
  const info = await conn.getAccountInfo(poolKey);
  if (!info || !info.owner.equals(LAUNCHLAB_PROGRAM)) throw new Error('LaunchLab pool not found');
  const pool = LaunchpadPool.decode(info.data);
  if (!pool.mintA.equals(mint)) throw new Error('LaunchLab pool mint mismatch');
  if (!pool.mintB.equals(NATIVE_MINT)) throw new Error('only SOL-quoted LaunchLab curves are supported');
  const [cfgInfo, platInfo] = await conn.getMultipleAccountsInfo([pool.configId, pool.platformId]);
  if (!cfgInfo || !platInfo) throw new Error('LaunchLab config not found');
  const config = LaunchpadConfig.decode(cfgInfo.data);
  const platform = PlatformConfig.decode(platInfo.data);
  const m = await mintInfo(conn, mint);
  const st = {
    venue: 'raydium_launchlab', mint: mint.toBase58(), poolKey, pool, config, platform,
    tokenProgram: m.program, decimals: m.decimals, tokenBalance: await balanceOf(conn, mint, user, m.program),
    status: Number(pool.status), migrateType: Number(pool.migrateType),
  };
  // graduation target: CPMM pool derived from the platform's CPMM config (migrateType 1); AMM v4 (0) is not supported
  if (st.status !== 0 && st.migrateType === 1) {
    const [a, b] = Buffer.compare(NATIVE_MINT.toBuffer(), mint.toBuffer()) < 0 ? [NATIVE_MINT, mint] : [mint, NATIVE_MINT];
    st.migratedPool = getCpmmPdaPoolId(CPMM_PROGRAM, platform.cpConfigId, a, b).publicKey;
  }
  return st;
}

function llFees(st) {
  return {
    protocolFeeRate: st.config.tradeFeeRate, platformFeeRate: st.platform.feeRate, creatorFeeRate: st.platform.creatorFeeRate,
    shareFeeRate: ZERO, curveType: Number(st.config.curveType), transferFeeConfigA: undefined, transferFeeConfigB: undefined, slot: 0,
  };
}

function llTradable(st) {
  if (st.status === 0) return;
  if (st.migrateType === 0) throw new Error('this LaunchLab coin graduated to Raydium AMM v4 (not supported yet)');
  throw new Error('LaunchLab curve is complete and waiting for migration (usually a few seconds); try again shortly');
}

export function quoteLaunchLab(st, buy, amountIn) {
  llTradable(st);
  if (buy) return Curve.buyExactIn({ poolInfo: st.pool, amountB: amountIn, ...llFees(st) }).amountA.amount;
  return Curve.sellExactIn({ poolInfo: st.pool, amountA: amountIn, ...llFees(st) }).amountB;
}

export function buildLaunchLab(st, user, req, slippage) {
  llTradable(st);
  const buy = req.side === 'buy';
  const amountIn = buy ? new BN(lamports(req.sol)) : pctOf(st.tokenBalance, req.percent);
  if (amountIn.lten(0)) throw new Error(buy ? 'invalid buy amount' : 'no token balance to sell');
  const out = quoteLaunchLab(st, buy, amountIn);
  if (out.lten(0)) throw new Error('quote returned 0 tokens');
  const p = st.pool, mint = new PublicKey(st.mint);
  const args = [
    LAUNCHLAB_PROGRAM, user, getPdaLaunchpadAuth(LAUNCHLAB_PROGRAM).publicKey, p.configId, p.platformId, st.poolKey,
    tokenAta(st, user), wsolAta(user), p.vaultA, p.vaultB, mint, NATIVE_MINT, st.tokenProgram, TOKEN_PROGRAM_ID,
    getPdaPlatformVault(LAUNCHLAB_PROGRAM, p.platformId, NATIVE_MINT).publicKey,
    getPdaCreatorVault(LAUNCHLAB_PROGRAM, p.creator, NATIVE_MINT).publicKey,
    amountIn, minOut(out, slippage), ZERO,
  ];
  const ix = buy ? buyExactInInstruction(...args) : sellExactInInstruction(...args);
  return {
    ixs: [createTokenAta(st, user), ix],
    wrapLamports: buy ? amountIn : ZERO, // SOL side goes through the user's WSOL ATA (wrapped/unwrapped by trade.js)
    quote: { amountIn: amountIn.toString(), expectedOut: out.toString(), minOut: minOut(out, slippage).toString() },
  };
}

// ---------------- CPMM ----------------
const CPMM_SWAP_DISABLED = 4; // pool status bit 2

export async function loadCpmm(conn, poolKey, mint, user) {
  const info = await conn.getAccountInfo(poolKey);
  if (!info || !info.owner.equals(CPMM_PROGRAM)) throw new Error('CPMM pool not found');
  const pool = CpmmPoolInfoLayout.decode(info.data);
  const tokenIsA = pool.mintA.equals(mint);
  if (!tokenIsA && !pool.mintB.equals(mint)) throw new Error('CPMM pool does not contain this token');
  if (!(tokenIsA ? pool.mintB : pool.mintA).equals(NATIVE_MINT)) throw new Error('only SOL-paired CPMM pools are supported');
  const [cfgInfo, vA, vB] = await conn.getMultipleAccountsInfo([pool.configId, pool.vaultA, pool.vaultB]);
  if (!cfgInfo || !vA || !vB) throw new Error('CPMM pool accounts not found');
  const amount = (key, acc, program) => new BN(unpackAccount(key, acc, program).amount.toString());
  const st = {
    venue: 'raydium_cpmm', mint: mint.toBase58(), poolKey, pool, config: CpmmConfigInfoLayout.decode(cfgInfo.data), tokenIsA,
    // reserves exclude fees owed to the protocol / fund / creator (same as the program)
    reserveA: amount(pool.vaultA, vA, pool.mintProgramA).sub(pool.protocolFeesMintA).sub(pool.fundFeesMintA).sub(pool.creatorFeesMintA),
    reserveB: amount(pool.vaultB, vB, pool.mintProgramB).sub(pool.protocolFeesMintB).sub(pool.fundFeesMintB).sub(pool.creatorFeesMintB),
    tokenProgram: tokenIsA ? pool.mintProgramA : pool.mintProgramB,
    decimals: tokenIsA ? pool.mintDecimalA : pool.mintDecimalB,
  };
  st.tokenBalance = await balanceOf(conn, mint, user, st.tokenProgram);
  return st;
}

function cpmmSide(st, buy) {
  const inputIsA = buy ? !st.tokenIsA : st.tokenIsA; // buy: SOL in
  const p = st.pool;
  return {
    inputIsA,
    inReserve: inputIsA ? st.reserveA : st.reserveB, outReserve: inputIsA ? st.reserveB : st.reserveA,
    inVault: inputIsA ? p.vaultA : p.vaultB, outVault: inputIsA ? p.vaultB : p.vaultA,
    inMint: inputIsA ? p.mintA : p.mintB, outMint: inputIsA ? p.mintB : p.mintA,
    inProgram: inputIsA ? p.mintProgramA : p.mintProgramB, outProgram: inputIsA ? p.mintProgramB : p.mintProgramA,
  };
}

export function quoteCpmm(st, buy, amountIn) {
  if (Number(st.pool.status) & CPMM_SWAP_DISABLED) throw new Error('swaps are disabled on this CPMM pool');
  if (Number(st.pool.openTime) > Date.now() / 1000) throw new Error('this CPMM pool is not open for trading yet');
  const s = cpmmSide(st, buy), c = st.config;
  // creator fee: only when enabled on the pool; taken from the input when feeOn is both tokens or the input token
  const feeOn = Number(st.pool.feeOn);
  const onInput = feeOn === 0 ? true : feeOn === 1 ? s.inputIsA : !s.inputIsA;
  const creatorRate = st.pool.enableCreatorFee ? c.creatorFeeRate : ZERO;
  return CurveCalculator.swapBaseInput(amountIn, s.inReserve, s.outReserve, c.tradeFeeRate, creatorRate, c.protocolFeeRate, c.fundFeeRate, onInput).outputAmount;
}

export function buildCpmm(st, user, req, slippage) {
  const buy = req.side === 'buy';
  const amountIn = buy ? new BN(lamports(req.sol)) : pctOf(st.tokenBalance, req.percent);
  if (amountIn.lten(0)) throw new Error(buy ? 'invalid buy amount' : 'no token balance to sell');
  const out = quoteCpmm(st, buy, amountIn);
  if (out.lten(0)) throw new Error('quote returned 0 tokens');
  const s = cpmmSide(st, buy), p = st.pool;
  const userIn = getAssociatedTokenAddressSync(s.inMint, user, true, s.inProgram);
  const userOut = getAssociatedTokenAddressSync(s.outMint, user, true, s.outProgram);
  const ix = makeSwapCpmmBaseInInstruction(
    CPMM_PROGRAM, user, getPdaPoolAuthority(CPMM_PROGRAM).publicKey, p.configId, st.poolKey,
    userIn, userOut, s.inVault, s.outVault, s.inProgram, s.outProgram, s.inMint, s.outMint, p.observationId,
    amountIn, minOut(out, slippage),
  );
  return {
    ixs: [createTokenAta(st, user), ix],
    wrapLamports: buy ? amountIn : ZERO,
    quote: { amountIn: amountIn.toString(), expectedOut: out.toString(), minOut: minOut(out, slippage).toString() },
  };
}
