// Empty token accounts: list them and close them in batches to get the rent back (settings, popup only).
// Only zero-balance accounts owned and closable by the DX wallet; rent always goes back to the wallet.
import { PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import { getKeypair } from './vault.js';
import * as market from './market.js';
import * as tokenMeta from './meta.js';

const PER_TX = 20;              // ~1.0 KB per tx with 20 closes
const CU_PER_CLOSE = 3_000;
const PRIORITY_MICRO = 20_000;
export const feePerTx = (n) => 5_000 + Math.ceil((PRIORITY_MICRO * (n * CU_PER_CLOSE + 1_000)) / 1e6);

export async function scan() {
  const kp = await getKeypair();
  if (!kp) throw new Error('wallet is locked');
  const owner = kp.publicKey.toBase58();
  const c = await market.connection();
  const list = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = await c.getParsedTokenAccountsByOwner(kp.publicKey, { programId }, 'confirmed');
    for (const { pubkey, account } of r.value) {
      const info = account.data && account.data.parsed && account.data.parsed.info;
      if (!info || info.owner !== owner || !info.tokenAmount || info.tokenAmount.amount !== '0') continue;
      if (info.closeAuthority && info.closeAuthority !== owner) continue;
      // Token-2022: withheld transfer fees block closing
      if ((info.extensions || []).some((e) => e.extension === 'transferFeeAmount' && e.state && Number(e.state.withheldAmount) > 0)) continue;
      list.push({ account: pubkey.toBase58(), mint: info.mint, lamports: account.lamports, program: programId.toBase58() });
    }
  }
  await tokenMeta.ensureMany(list.map((a) => a.mint)).catch(() => {});
  for (const a of list) { const m = tokenMeta.get(a.mint); a.symbol = m && m.symbol ? m.symbol : null; }
  list.sort((a, b) => b.lamports - a.lamports);
  const txs = Math.ceil(list.length / PER_TX);
  return { list, lamports: list.reduce((s, a) => s + a.lamports, 0), txs, fee: list.length ? feePerTx(PER_TX) * (txs - 1) + feePerTx(list.length - PER_TX * (txs - 1)) : 0 };
}

// Closes the requested accounts that a fresh scan still reports as empty.
export async function closeAll(accounts, confirm) {
  const kp = await getKeypair();
  if (!kp) throw new Error('wallet is locked');
  const want = new Set((accounts || []).map(String));
  const fresh = (await scan()).list.filter((a) => want.has(a.account));
  if (!fresh.length) throw new Error('정리할 빈 토큰 계정이 없습니다');
  const c = await market.connection();
  const out = { closed: 0, lamports: 0, signatures: [], failed: 0 };
  for (let i = 0; i < fresh.length; i += PER_TX) {
    const batch = fresh.slice(i, i + PER_TX);
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: batch.length * CU_PER_CLOSE + 1_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO }),
      ...batch.map((a) => createCloseAccountInstruction(new PublicKey(a.account), kp.publicKey, kp.publicKey, [], new PublicKey(a.program))),
    ];
    // only CloseAccount (index 9) to our own wallet, signed by our own wallet
    for (const ix of ixs.slice(2)) {
      if (ix.data[0] !== 9 || !ix.keys[1].pubkey.equals(kp.publicKey) || !ix.keys[2].pubkey.equals(kp.publicKey)) throw new Error('unexpected close instruction');
    }
    const { blockhash } = await c.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    tx.sign([kp]);
    try {
      const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      out.signatures.push(sig);
      const conf = await confirm(sig);
      if (conf.status === 'confirmed') { out.closed += batch.length; out.lamports += batch.reduce((s, a) => s + a.lamports, 0); } else out.failed += batch.length;
    } catch (_) { out.failed += batch.length; }
  }
  return out;
}
