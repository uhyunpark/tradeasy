// Jupiter routing for coins whose pool is not paired with SOL (PUMP, HYPE, USDC, BTC, ... quotes).
// Only `/swap/v2/build` is used: Jupiter returns the route as instructions, with no Jupiter swap fee;
// signing, compute budget, tip and sending stay ours (Sender). Called at click time (one HTTP request).
import { PublicKey, TransactionInstruction, AddressLookupTableAccount } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';

export const JUPITER_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const BUILD_URL = 'https://api.jup.ag/swap/v2/build';

const toIx = (ix) => new TransactionInstruction({
  programId: new PublicKey(ix.programId),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(ix.data, 'base64'),
});

// amount: BN in the input token's base units. Returns swap ixs (no compute budget), lookup tables and the quote.
export async function buildJupiter({ mint, user, side, amount, slippage, apiKey, maxAccounts = 48 }) {
  const sol = NATIVE_MINT.toBase58();
  const q = new URLSearchParams({
    inputMint: side === 'buy' ? sol : mint,
    outputMint: side === 'buy' ? mint : sol,
    amount: amount.toString(),
    taker: user.toBase58(),
    slippageBps: String(Math.round(slippage * 100)),
    maxAccounts: String(maxAccounts),
    wrapAndUnwrapSol: 'true',
  });
  const headers = apiKey ? { 'x-api-key': apiKey } : {};
  const r = await fetch(`${BUILD_URL}?${q}`, { headers, signal: AbortSignal.timeout(6000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Error('Jupiter: rate limited (429)');
  if (!r.ok || j.error) throw new Error('Jupiter: ' + (j.error || `HTTP ${r.status}`));
  if (!j.swapInstruction) throw new Error('Jupiter: no route');
  const ixs = [
    ...(j.setupInstructions || []).map(toIx),
    ...(j.otherInstructions || []).map(toIx),
    toIx(j.swapInstruction),
    ...(j.cleanupInstruction ? [toIx(j.cleanupInstruction)] : []),
  ];
  const alts = Object.entries(j.addressesByLookupTableAddress || {}).map(([key, addresses]) => new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addresses.map((a) => new PublicKey(a)) },
  }));
  const route = (j.routePlan || []).map((s) => s.swapInfo && s.swapInfo.label).filter(Boolean);
  return {
    ixs, alts,
    quote: { inAmount: j.inAmount, outAmount: j.outAmount, minOut: j.otherAmountThreshold, priceImpactPct: Number(j.priceImpactPct || 0), route },
  };
}
