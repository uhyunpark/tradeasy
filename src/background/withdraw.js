import '../i18n-en.js';
import '../i18n.js';
// Send SOL out of the Tradeasy wallet (popup only). Plain System transfer via the RPC.
import { PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getKeypair } from './vault.js';
import * as market from './market.js';

const T = (k, v) => globalThis.TE_I18N.T(k, v);

const PRIORITY_MICRO = 20_000; // tiny priority (~0.000004 SOL at 200 CU... capped below)
const CU = 1_000;
export const FEE_LAMPORTS = 5_000 + Math.ceil((PRIORITY_MICRO * CU) / 1e6);

export async function plan({ to, sol, max }) {
  const kp = await getKeypair();
  if (!kp) throw new Error('wallet is locked');
  let dest;
  try { dest = new PublicKey(String(to || '').trim()); } catch (_) { throw new Error(T('받는 주소가 올바른 Solana 주소가 아닙니다')); }
  if (dest.equals(kp.publicKey)) throw new Error(T('Tradeasy 지갑 자신에게는 보낼 수 없습니다'));
  const c = await market.connection();
  const bal = await c.getBalance(kp.publicKey, 'confirmed');
  const lamports = max ? bal - FEE_LAMPORTS : Math.round(Number(sol) * 1e9);
  if (!(lamports > 0)) throw new Error(max ? T('보낼 수 있는 SOL이 없습니다') : T('금액을 입력하세요'));
  if (lamports + FEE_LAMPORTS > bal) throw new Error(T('잔고가 부족합니다 (잔고 {bal} SOL, 수수료 {fee} SOL)', { bal: (bal / 1e9).toFixed(6), fee: (FEE_LAMPORTS / 1e9).toFixed(6) }));
  // the destination must end up rent-exempt if it is a brand new account
  const info = await c.getAccountInfo(dest, 'confirmed');
  if (!info && lamports < 890_880) throw new Error(T('새 주소로는 최소 0.00089088 SOL 이상 보내야 합니다'));
  return { kp, dest, lamports, bal, newAccount: !info };
}

export async function send(req) {
  const { kp, dest, lamports } = await plan(req);
  const c = await market.connection();
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: kp.publicKey, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO }),
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const signature = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  return { signature, lamports, lastValidBlockHeight };
}
