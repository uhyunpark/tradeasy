// Turn SDK / RPC / simulation errors into one short sentence (Korean key, translated by i18n). Raw text stays in "details".
import '../i18n-en.js';
import '../i18n.js';
import * as tokenMeta from './meta.js';

const T = (k, v) => globalThis.TE_I18N.T(k, v);

const QUOTES = { pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: 'PUMP', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT', USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: 'USD1',
  '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g': 'HYPE' };
const RULES = [
  [/Jupiter: rate limited/i, 'Jupiter 요청 한도에 걸렸습니다. 2초 뒤 다시 시도하세요 (설정 > 고급에서 Jupiter API key를 넣으면 한도가 늘어납니다).'],
  [/Jupiter: (No routes found|no route)/i, 'Jupiter가 거래 경로를 찾지 못했습니다.'],
  [/Jupiter:/i, 'Jupiter 경로를 받아오지 못했습니다. 잠시 후 다시 시도하세요.'],
  [/only SOL-(?:quoted|paired)[^(]*\(quote (\w+)\)/i, (m) => {
    const meta = tokenMeta.get(m[1]);
    const sym = QUOTES[m[1]] || (meta && meta.symbol) || null;
    return sym
      ? T('{sym} 페어 코인입니다. SOL이 아니라 {sym}로 사고파는 풀이라 Tradeasy는 아직 지원하지 않습니다.', { sym })
      : T('SOL이 아닌 다른 토큰({mint})과 페어인 코인이라 Tradeasy는 아직 지원하지 않습니다.', { mint: `${m[1].slice(0, 4)}…${m[1].slice(-4)}` });
  }],
  [/only SOL-(?:quoted|paired)/i, 'SOL이 아닌 다른 토큰과 페어인 코인이라 Tradeasy는 아직 지원하지 않습니다.'],
  [/wallet is locked/i, '지갑이 잠겨 있습니다. Tradeasy 팝업에서 잠금을 해제하세요.'],
  [/API key is not set|no rpc/i, 'Helius가 연결되지 않았습니다. Tradeasy 팝업 > 설정에서 API key를 입력하세요.'],
  [/exceeds max per trade \(([\d.]+)\)/i, (m) => T('1회 최대 금액({max} SOL)을 넘습니다. Tradeasy 설정에서 바꿀 수 있습니다.', { max: m[1] })],
  [/wallet has no SOL|AccountNotFound/i, 'Tradeasy 지갑에 SOL이 없습니다. 먼저 입금하세요.'],
  [/no token balance to sell/i, '팔 토큰이 Tradeasy 지갑에 없습니다.'],
  [/graduated to Raydium AMM v4/i, 'Raydium AMM v4로 졸업한 토큰이라 아직 지원하지 않습니다.'],
  [/unsupported venue/i, '아직 지원하지 않는 풀입니다 (Raydium AMM v4·CLMM, Meteora DLMM 등).'],
  [/swaps are disabled/i, '이 풀은 현재 거래가 중지되어 있습니다.'],
  [/not open for trading yet/i, '아직 거래가 시작되지 않은 풀입니다.'],
  [/waiting for migration|PoolIsCompleted/i, '본딩 커브가 끝나 다음 풀로 옮겨지는 중입니다. 몇 초 뒤 다시 시도하세요.'],
  [/has graduated|BondingCurveComplete/i, '본딩 커브가 끝났습니다. 페이지를 새로고침하면 새 풀로 거래합니다.'],
  [/TooMuchSolRequired|TooLittleSolReceived|BuySlippageBelowMin\w*|SlippageBelowMin\w*|ExceededSlippage|SlippageExceeded|exceeds desired slippage|slippage tolerance|AmountOutLessThanMinimum|MinimumAmountOut/i,
    '가격이 slippage 범위를 벗어났습니다. slippage를 높이거나 다시 시도하세요.'],
  [/insufficient lamports|InsufficientFunds|insufficient funds/i, 'SOL 잔고가 부족합니다 (금액 + 수수료 + 계정 생성 비용).'],
  [/BlockhashNotFound|blockhash not found|expired/i, '블록해시가 만료되었습니다. 다시 시도하세요.'],
  [/exceeds preset max fee/i, 'priority + tip이 프리셋의 최대 수수료보다 큽니다.'],
  [/invalid slippage/i, '프리셋의 slippage 값이 올바르지 않습니다.'],
  [/unexpected program|unexpected account|unexpected system|outflow .* exceeds cap/i, '안전 검사에서 막혔습니다. 예상하지 못한 instruction이 있어 서명하지 않았습니다.'],
  [/transaction too large/i, '트랜잭션이 너무 큽니다.'],
  [/Sender: .*(rate|429|limit)/i, 'Helius Sender 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.'],
  [/Sender:/i, 'Helius Sender가 전송을 거부했습니다.'],
  [/Liquidity in bonding curve is insufficient|insufficient liquidity/i, '남은 유동성보다 큰 금액입니다. 금액을 줄이세요.'],
  [/quote returned 0 tokens/i, '받을 토큰이 0입니다. 금액이 너무 작습니다.'],
  [/Failed to fetch|NetworkError|timeout/i, '네트워크 응답이 없습니다. 연결을 확인하세요.'],
];

export function explain(...parts) {
  const text = parts.filter(Boolean).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
  for (const [re, msg] of RULES) {
    const m = re.exec(text);
    if (m) return typeof msg === 'function' ? msg(m) : T(msg);
  }
  return null;
}
