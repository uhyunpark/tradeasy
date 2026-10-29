// Venue-agnostic quotes from the cached pool/curve state. No RPC at call time
// (Meteora reads go through the cache connection that refresh() warmed).
import BN from 'bn.js';
import { getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { buyQuoteInput, sellBaseInput } from '@pump-fun/pump-sdk/swap';
import { quoteDammV2, quoteDbc } from './meteora.js';
import { quoteLaunchLab, quoteCpmm } from './raydium.js';
import * as market from './market.js';

function ammArgs(ss) {
  const { baseMint, baseMintAccount, feeConfig, globalConfig, pool, poolBaseAmount, poolQuoteAmount } = ss;
  return {
    slippage: 1, quoteTransferFee: ss.quoteTransferFee, baseReserve: poolBaseAmount, quoteReserve: poolQuoteAmount,
    virtualQuoteReserves: pool.virtualQuoteReserves, baseMintAccount, baseMint, coinCreator: pool.coinCreator, creator: pool.creator,
    feeConfig, globalConfig, quoteMint: pool.quoteMint, isMayhemMode: pool.isMayhemMode, creatorFeeBps: pool.creatorFeeBps,
  };
}

// buy: amountIn = lamports -> token base units out. sell: amountIn = token base units -> lamports out.
export async function quoteOut(st, side, amountIn) {
  const buy = side === 'buy';
  if (amountIn.lten(0)) return new BN(0);
  if (st.venue === 'pump') {
    const { global, feeConfig, bondingCurve } = st;
    return buy
      ? getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: amountIn, quoteMint: bondingCurve.quoteMint })
      : getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: bondingCurve.tokenTotalSupply, bondingCurve, amount: amountIn });
  }
  if (st.venue === 'pumpswap') {
    const ss = st.swapState, a = ammArgs(ss);
    if (!st.reversed) {
      return buy ? buyQuoteInput({ ...a, quote: amountIn, tradeV2: false }).base
        : sellBaseInput({ ...a, base: amountIn, feeBucketsTotal: ss.pool.protocolFees.add(ss.pool.creatorFees) }).uiQuote;
    }
    // reversed pool: base = SOL, quote = token
    return buy ? sellBaseInput({ ...a, base: amountIn, feeBucketsTotal: ss.pool.protocolFees.add(ss.pool.creatorFees) }).uiQuote
      : buyQuoteInput({ ...a, quote: amountIn, tradeV2: false }).base;
  }
  if (st.venue === 'raydium_launchlab') return quoteLaunchLab(st, buy, amountIn);
  if (st.venue === 'raydium_cpmm') return quoteCpmm(st, buy, amountIn);
  const c = await market.cacheConnection();
  if (st.venue === 'meteora_damm_v2') return quoteDammV2(c, st, buy, amountIn);
  if (st.venue === 'meteora_dbc') return quoteDbc(c, st, buy, amountIn);
  throw new Error('no local quote for venue ' + st.venue); // jupiter: quoted at click time
}

const pctOf = (bn, pct) => bn.mul(new BN(Math.round(pct * 100))).div(new BN(10_000));

// output per input unit for a tiny trade (first size that quotes > 0); 0 when none does
async function refRateOf(st, side, sizes) {
  for (const n of sizes) {
    if (n.lten(0)) continue;
    try { const o = await quoteOut(st, side, n); if (o.gtn(0)) return Number(o.toString()) / Number(n.toString()); } catch (_) {}
  }
  return 0;
}

// Preview for the popover: expected output + price impact (vs a tiny reference trade, so fees
// that scale with size are not counted as impact).
export async function preview(st, decimals, { side, sols = [], pcts = [] }) {
  const toUi = (bn, d) => Number(bn.toString()) / 10 ** d;
  const out = [];
  if (st.venue === 'jupiter') return out; // routed at click time: no local quote
  if (side === 'buy') {
    const refRate = await refRateOf(st, 'buy', [new BN(1_000_000), new BN(10_000_000)]); // 0.001 / 0.01 SOL
    for (const sol of sols) {
      const inL = new BN(Math.round(Number(sol) * 1e9));
      try {
        const o = await quoteOut(st, 'buy', inL);
        const rate = Number(o.toString()) / Number(inL.toString());
        out.push({ sol, out: toUi(o, decimals), impact: refRate > 0 ? Math.max(0, 1 - rate / refRate) * 100 : null });
      } catch (e) { out.push({ sol, error: e.message }); }
    }
  } else {
    const bal = st.tokenBalance;
    const refRate = bal.gtn(0) ? await refRateOf(st, 'sell', [bal.divn(10_000), bal.divn(1_000), bal.divn(100)]) : 0;
    for (const pct of pcts) {
      const inT = pctOf(bal, pct);
      if (inT.lten(0)) { out.push({ pct, out: 0, impact: null }); continue; }
      try {
        const o = await quoteOut(st, 'sell', inT);
        const rate = Number(o.toString()) / Number(inT.toString());
        out.push({ pct, out: toUi(o, 9), impact: refRate > 0 ? Math.max(0, 1 - rate / refRate) * 100 : null });
      } catch (e) { out.push({ pct, error: e.message }); }
    }
  }
  return out;
}

// SOL you would get for selling the whole Tradeasy balance now (after fees and impact).
export async function liquidationValue(st) {
  if (!st.tokenBalance || st.tokenBalance.lten(0)) return 0;
  try { return Number((await quoteOut(st, 'sell', st.tokenBalance)).toString()) / 1e9; } catch (_) { return null; }
}

// mid price in SOL per (UI) token: geometric mean of a tiny buy and the matching sell, so the pool fee cancels out
export async function spotPrice(st, decimals) {
  const lam = new BN(1_000_000); // 0.001 SOL
  const tokOut = await quoteOut(st, 'buy', lam);
  if (tokOut.lten(0)) return null;
  const ui = Number(tokOut.toString()) / 10 ** decimals;
  const pb = 0.001 / ui;
  let ps = 0;
  try { ps = Number((await quoteOut(st, 'sell', tokOut)).toString()) / 1e9 / ui; } catch (_) {}
  return ps > 0 ? Math.sqrt(pb * ps) : pb;
}
