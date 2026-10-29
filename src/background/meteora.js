// Meteora venues: DBC (dynamic bonding curve) and DAMM v2 (cp-amm).
// load*()  runs at page entry through the LIVE connection (warms the RPC cache).
// build*() runs at click time through the CACHE connection (no RPC on a warm cache).
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  unpackMint, unpackAccount,
} from '@solana/spl-token';
import BN from 'bn.js';
import { CpAmm, CP_AMM_PROGRAM_ID, SwapMode as DammSwapMode } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID, SwapMode as DbcSwapMode, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';

export const DAMM_V2_PROGRAM = CP_AMM_PROGRAM_ID;
export const DBC_PROGRAM = DYNAMIC_BONDING_CURVE_PROGRAM_ID;

const lamports = (sol) => Math.round(Number(sol) * 1e9);
const pctOf = (bn, pct) => bn.mul(new BN(Math.round(pct * 100))).div(new BN(10_000));

async function mintInfo(conn, mint) {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return { program: info.owner, mint: unpackMint(mint, info, info.owner) };
}

async function balanceOf(conn, mint, owner, program) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
  const info = await conn.getAccountInfo(ata);
  if (!info) return new BN(0);
  try { return new BN(unpackAccount(ata, info, program).amount.toString()); } catch (_) { return new BN(0); }
}

async function currentPoint(conn, activationType) {
  const slot = await conn.getSlot('confirmed');
  if (Number(activationType) === 0) return new BN(slot);
  return new BN(Math.floor(Date.now() / 1000)); // timestamp-based activation: wall clock is close enough for fee schedules
}

// Make sure the user's WSOL and token ATAs are created (idempotent) even if the cached
// "account exists" view is stale (e.g. the WSOL ATA was closed by the previous swap).
function ensureAtas(ixs, user, mints) {
  const existing = new Set(ixs.filter((ix) => ix.programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL').map((ix) => ix.keys[1].pubkey.toBase58()));
  const add = [];
  for (const { mint, program } of mints) {
    const ata = getAssociatedTokenAddressSync(mint, user, true, program);
    if (!existing.has(ata.toBase58())) add.push(createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint, program));
  }
  return [...add, ...ixs];
}
const stripBudget = (ixs) => ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

// ---------------- DAMM v2 ----------------
export async function loadDammV2(conn, poolKey, mint, user) {
  const amm = new CpAmm(conn);
  const poolState = await amm.fetchPoolState(poolKey);
  const aIsMint = poolState.tokenAMint.equals(mint), bIsMint = poolState.tokenBMint.equals(mint);
  if (!aIsMint && !bIsMint) throw new Error('DAMM v2 pool does not contain this token');
  const quoteMint = aIsMint ? poolState.tokenBMint : poolState.tokenAMint;
  if (!quoteMint.equals(NATIVE_MINT)) throw new Error('only SOL-quoted pools are supported');
  const [a, b] = await Promise.all([mintInfo(conn, poolState.tokenAMint), mintInfo(conn, poolState.tokenBMint)]);
  const tokenProgram = aIsMint ? a.program : b.program;
  const point = await currentPoint(conn, poolState.activationType); // warms getSlot
  const tokenBalance = await balanceOf(conn, mint, user, tokenProgram);
  return { venue: 'meteora_damm_v2', mint: mint.toBase58(), poolKey, poolState, a, b, tokenProgram, tokenBalance, point };
}

export async function buildDammV2(conn, st, user, req, slippage) {
  const amm = new CpAmm(conn);
  const mint = new PublicKey(st.mint);
  const ps = st.poolState;
  const buy = req.side === 'buy';
  const inputMint = buy ? NATIVE_MINT : mint;
  const outputMint = buy ? mint : NATIVE_MINT;
  const amountIn = buy ? new BN(lamports(req.sol)) : pctOf(st.tokenBalance, req.percent);
  if (amountIn.lten(0)) throw new Error(buy ? 'invalid buy amount' : 'no token balance to sell');
  const epoch = 0; // transfer-fee epoch: only matters for Token-2022 transfer-fee mints
  const inInfo = inputMint.equals(ps.tokenAMint) ? st.a : st.b;
  const outInfo = outputMint.equals(ps.tokenAMint) ? st.a : st.b;
  const point = await currentPoint(conn, ps.activationType);
  const q = amm.getQuote2({
    inputTokenMint: inputMint, slippage: Math.round(slippage * 100), currentPoint: point, poolState: ps,
    inputTokenInfo: { mint: inInfo.mint, currentEpoch: epoch }, outputTokenInfo: { mint: outInfo.mint, currentEpoch: epoch },
    tokenADecimal: st.a.mint.decimals, tokenBDecimal: st.b.mint.decimals, hasReferral: false,
    swapMode: DammSwapMode.ExactIn, amountIn,
  });
  const tx = await amm.swap2({
    payer: user, pool: st.poolKey, inputTokenMint: inputMint, outputTokenMint: outputMint,
    tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault,
    tokenAProgram: st.a.program, tokenBProgram: st.b.program, referralTokenAccount: null, poolState: ps,
    swapMode: DammSwapMode.ExactIn, amountIn, minimumAmountOut: q.minimumAmountOut,
  });
  const ixs = ensureAtas(stripBudget(tx.instructions), user, [{ mint: NATIVE_MINT, program: TOKEN_PROGRAM_ID }, { mint, program: st.tokenProgram }]);
  return {
    ixs,
    quote: { amountIn: amountIn.toString(), expectedOut: (q.outputAmount || q.outAmount || new BN(0)).toString(), minOut: q.minimumAmountOut.toString() },
    wrapLamports: buy ? amountIn.toNumber() : 0,
  };
}

// ---------------- DBC ----------------
export async function loadDbc(conn, poolKey, mint, user) {
  const client = new DynamicBondingCurveClient(conn, 'confirmed');
  const virtualPool = await client.state.getPool(poolKey);
  if (!virtualPool) throw new Error('DBC pool not found');
  const vps = virtualPool.poolState || virtualPool; // account layout nests the fields under poolState
  if (!vps.baseMint.equals(mint)) throw new Error('DBC pool baseMint mismatch');
  const config = await client.state.getPoolConfig(vps.config);
  if (!config) throw new Error('DBC config not found');
  if (!config.quoteMint.equals(NATIVE_MINT)) throw new Error('only SOL-quoted curves are supported');
  const migrated = Number(vps.isMigrated || 0) !== 0;
  // curve filled up to the migration threshold: swaps are closed until the migration tx lands
  const completed = !migrated && (Number(vps.finishCurveTimestamp || 0) > 0 || !!(vps.quoteReserve && config.migrationQuoteThreshold && vps.quoteReserve.gte(config.migrationQuoteThreshold)));
  const base = await mintInfo(conn, mint);
  const point = await currentPoint(conn, config.activationType);
  const tokenBalance = await balanceOf(conn, mint, user, base.program);
  // after graduation the curve's liquidity sits in a DAMM v2 pool derived from the migration fee config
  let migratedPool = null;
  if ((migrated || completed) && Number(config.migrationOption) === 1) {
    const feeCfg = DAMM_V2_MIGRATION_FEE_ADDRESS[Number(config.migrationFeeOption)];
    if (feeCfg) migratedPool = deriveDammV2PoolAddress(feeCfg, mint, NATIVE_MINT);
  }
  const st = { venue: 'meteora_dbc', mint: mint.toBase58(), poolKey, virtualPool, config, base, tokenProgram: base.program, tokenBalance, migrated, completed, migratedPool, point };
  // warm the cache with everything swap2 reads (pool, config, ATAs, slot)
  if (!migrated && !completed) { try { await buildDbc(conn, st, user, { side: 'buy', sol: 0.001 }, 10); } catch (_) {} }
  return st;
}

export async function buildDbc(conn, st, user, req, slippage) {
  if (st.migrated) throw new Error('this DBC curve has graduated: reload the page to trade the migrated pool');
  if (st.completed) throw new Error('DBC curve is complete and waiting for migration (usually a few seconds); try again shortly');
  const client = new DynamicBondingCurveClient(conn, 'confirmed');
  const mint = new PublicKey(st.mint);
  const buy = req.side === 'buy';
  const amountIn = buy ? new BN(lamports(req.sol)) : pctOf(st.tokenBalance, req.percent);
  if (amountIn.lten(0)) throw new Error(buy ? 'invalid buy amount' : 'no token balance to sell');
  const point = await currentPoint(conn, st.config.activationType);
  const q = client.pool.swapQuote2({
    virtualPool: st.virtualPool, config: st.config, swapBaseForQuote: !buy, hasReferral: false,
    eligibleForFirstSwapWithMinFee: false, currentPoint: point, slippageBps: Math.round(slippage * 100),
    swapMode: DbcSwapMode.ExactIn, amountIn,
  });
  const minOut = q.minimumAmountOut || new BN(0);
  const tx = await client.pool.swap2({
    owner: user, pool: st.poolKey, swapBaseForQuote: !buy, referralTokenAccount: null,
    swapMode: DbcSwapMode.ExactIn, amountIn, minimumAmountOut: minOut,
  });
  const ixs = ensureAtas(stripBudget(tx.instructions), user, [{ mint: NATIVE_MINT, program: TOKEN_PROGRAM_ID }, { mint, program: st.tokenProgram }]);
  return {
    ixs,
    quote: { amountIn: amountIn.toString(), expectedOut: (q.outputAmount || new BN(0)).toString(), minOut: minOut.toString() },
    wrapLamports: buy ? amountIn.toNumber() : 0,
  };
}

// ---------------- pure quotes (no tx build; reads only cached state) ----------------
export async function quoteDammV2(conn, st, buy, amountIn) {
  const amm = new CpAmm(conn);
  const ps = st.poolState, mint = new PublicKey(st.mint);
  const inputMint = buy ? NATIVE_MINT : mint, outputMint = buy ? mint : NATIVE_MINT;
  const inInfo = inputMint.equals(ps.tokenAMint) ? st.a : st.b;
  const outInfo = outputMint.equals(ps.tokenAMint) ? st.a : st.b;
  const point = await currentPoint(conn, ps.activationType);
  const q = amm.getQuote2({
    inputTokenMint: inputMint, slippage: 100, currentPoint: point, poolState: ps,
    inputTokenInfo: { mint: inInfo.mint, currentEpoch: 0 }, outputTokenInfo: { mint: outInfo.mint, currentEpoch: 0 },
    tokenADecimal: st.a.mint.decimals, tokenBDecimal: st.b.mint.decimals, hasReferral: false,
    swapMode: DammSwapMode.ExactIn, amountIn,
  });
  return new BN((q.outputAmount || q.outAmount || 0).toString());
}

export async function quoteDbc(conn, st, buy, amountIn) {
  if (st.migrated || st.completed) throw new Error('DBC curve is complete and waiting for migration (usually a few seconds); try again shortly');
  const client = new DynamicBondingCurveClient(conn, 'confirmed');
  const point = await currentPoint(conn, st.config.activationType);
  const q = client.pool.swapQuote2({
    virtualPool: st.virtualPool, config: st.config, swapBaseForQuote: !buy, hasReferral: false,
    eligibleForFirstSwapWithMinFee: false, currentPoint: point, slippageBps: 100,
    swapMode: DbcSwapMode.ExactIn, amountIn,
  });
  return new BN((q.outputAmount || 0).toString());
}
