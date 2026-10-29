# Tradeasy (DX Trader)

Chrome MV3 extension for Solana trading terminals (Axiom, GMGN). The user keeps using the terminal's UI and presets; DX builds, signs and sends the trade itself from a hot wallet inside the extension via Helius Sender, so the terminal fee (~1%) is not charged. No server, BYOK (one Helius API key for RPC + Sender). UI text is Korean; code and comments are English. The UI name is "DX Trader".

## Principles (do not break)

- **Never send a fee-paying terminal trade silently.** On Axiom (DX mode) every trade press is either executed by DX or blocked with a toast, also in orphaned tabs. Only trusted events (`isTrusted`) act.
- **Don't break the terminal.** Our UI lives in `#dx-layer` (overlay). Never block or modify the terminal's network traffic or workers (blocking Axiom's SharedWorker crashed the site). Interception is limited to user input events on trade controls.
- **Terminal data first** (presets, pool hints, blockhash feed, token meta); RPC only for prefetch, simulate, confirm.
- **Zero RPC at click time.** State is prefetched and served from the RPC cache (`market.js`, `cacheConnection`). e2e asserts this.
- **Verify before signing** (`trade.js` `verify`): program allowlist, SOL transfers only to Sender tip accounts or the own WSOL ATA, outflow cap. Pool addresses from the page are hints, verified on-chain (owner program, mint, SOL quote).
- **Simulate by default.** Live mode needs explicit confirmation in the popup.
- Venue SDKs directly, no aggregator. Every venue is detected, never assumed.

## Architecture

```
terminal page
  hook.js (MAIN world)      taps fetch/XHR/SharedWorker, reads React fibers, draws chart line
     │  window.postMessage({ __DX__: true, kind, payload })
  content.js (isolated)     site adapter, DX mode interception, badge/popover/toasts
     │  chrome.runtime.sendMessage
background (service worker) router, state cache, build/verify/sign/send/confirm, positions
     │
  popup.html/js             onboarding, wallet, current token + PnL, log, settings
```

- hook → content kinds: `blockhash`, `trade`, `pool-info`, `pair-info` (incl. name/symbol/image), `slippage`, `row-info` (answer to `resolve-row`). content → hook: `resolve-row`, `avg-line`.
- content → background: `watch` (+meta), `unwatch`, `feed:blockhash`, `feed:trade`, `state`, `quote`, `avgline`, `trade`. background → tab: `confirm`.
- popup → background: `wallet:*` (status/create/unlock/lock/reveal/remove/setPassword/balance/sendPlan/send), `config:get|set|test`, `trades:get`, `watch:get`, `accounts:scan|close`.
- The background checks the sender: site tabs (`axiom.trade`, `gmgn.ai`) vs the extension's own popup. Errors are returned as `{ error, friendly }` (`errors.js` maps to one Korean sentence; raw text goes in "자세히").

## Files

| File | Role |
|---|---|
| `build.mjs` | esbuild bundle of the background, copies static files, writes `dist/manifest.json`. Version lives here (and in `package.json`). |
| `src/hook.js` | MAIN world, `document_start`. Network/worker taps, fiber reads (`pairInfo.tokenAddress` of one-click rows), TradingView line. |
| `src/content.js` | `ADAPTERS.axiom/gmgn` (URL mint regex, main button detection, preset parsing), DX mode (`classify`/`handle`, covers, chip fill), toasts, avg-line poll. Retires itself when the extension context is invalidated. |
| `src/background/index.js` | Message router, per-tab watch map, periodic refresh + blockhash prefetch, trade log (20 trades, confirm merged into its send entry). |
| `market.js` | Caching connections, `refresh(mint, user, hint)` venue detection + state load, `summary()`. |
| `trade.js` | `buildIxs` (swap ixs per venue, compute budget, tip, verify), `execute` (simulate or Sender), `confirm`. |
| `meteora.js` / `raydium.js` | DAMM v2 + DBC / LaunchLab + CPMM load, quote, build. Pure after load. |
| `quote.js` | Pure quotes from cached state: popover preview, liquidation value, spot price. |
| `positions.js` | Per-mint PnL from confirmed live txs (balance deltas via jsonParsed `getTransaction`). |
| `accounts.js` | Zero-balance token accounts (Token + Token-2022): scan, close in batches of 20 (separate txs, plain RPC). |
| `withdraw.js` | SOL transfer out (popup only). |
| `meta.js` | Token name/symbol/image: terminal first, Helius DAS `getAsset`/`getAssetBatch` fallback. |
| `errors.js` | Error → Korean sentence. Names the quote token for non-SOL pairs. |
| `config.js` | Settings + defaults + `testRpc`. |
| `vault.js` | Wallet: plain, or PBKDF2 (310k) + AES-GCM with session unlock and auto-lock. |
| `src/shims.js`, `src/util-shim.js` | Buffer/process globals and a `util` shim for the browser bundle. |

## Trade flow

1. Page entry: content sends `watch` (mint, protocol/pool hints, meta). Background refreshes state: on Axiom about 1 s after each trade in the feed, otherwise when state is older than 12 s.
2. Click: content resolves side, amount (chip / input / one-click label) and preset, then sends `trade`.
3. Background: `buildIxs` from cached state → `verify` → sign → `simulateTransaction` (simulate mode) or Sender (live).
4. Live: reply immediately, then `confirm` (signature status polling, or the Axiom feed) → slots to land → `positions.deltas` → `positions.record` → `confirm` message to the tab (fill price, average price).

**Fees:** priority total = `preset.priorityFeeSol` (CU price = total / CU limit); Sender tip = `preset.bribeFeeSol`, at least 0.000005. A tip of 0.001 or more uses all Sender paths, below that `swqos_only=true`. `mev-protect` follows the preset unless `ignoreMev`. Axiom spends the same priority + bribe (as a tip transfer plus network fee), so the fixed cost is equal and DX saves the terminal fee.

**Buys spend exactly the chosen SOL:** pump `buy_exact_sol_in`, PumpSwap `buy_exact_quote_in`, min out = quote × (1 − slippage). `toExactIn` rewrites the SDK's exact-out `buy` (same accounts and arg layout; only the discriminator and the two amounts differ). Verified with mainnet `simulateTransaction`. Raydium/Meteora builders are exact-in already.

## Venues

Detection order in `market.refresh`:

1. A terminal pool hint → owner program: DAMM v2, DBC (follows the graduated DAMM v2 pool), LaunchLab (follows the graduated CPMM pool via `platform.cpConfigId`), CPMM, PumpSwap.
2. A protocol hint naming Raydium/LaunchLab without a pool → LaunchLab PDA `["pool", mintA, WSOL]`.
3. pump.fun bonding curve from the mint, then PumpSwap (hinted pool, then canonical pool; reversed pools with base = WSOL are supported).

SOL-quoted only. pump.fun also has non-SOL quote curves (e.g. PUMP-quoted): rejected with the quote mint in the error. Axiom trades these in one tx through its own router program (`FLASHX…`), e.g. PumpSwap token→HYPE then Orca Whirlpool HYPE→SOL. The SDK's `multiHopSwapInstructions` is the likely path if this is added. Not supported: Raydium AMM v4 (incl. LaunchLab coins that graduate there), CLMM, Meteora DLMM.

## Terminal data sources

- **Axiom**
  - Presets: `localStorage.settings` → `solPresets[currentSolPresetKey].buy/sell`, `solQuickSets`, `percentageQuickSets`. `solBuyAmountUnit` `native` means SOL.
  - Token: `token-and-best-pair-info` (protocol, bestPairAddress, name/ticker/image).
  - Feed: SharedWorker `axiom-client-socket` frames (`sol-v2|blockhash`, `sol-v2|t:<mint>`).
  - DOM: the market button is a `button` "Buy TOKEN" (img + amount span) that trades on pointerdown; chips are `div[role=button]`.
- **GMGN**
  - Presets: `localStorage.tradeConfigsV12` (`sol.buy/sell.tradeConfigs[tradeConfigIndex]`, `quickAmount`).
  - Token: XHR `mutil_window_token_info` (pool.exchange, pool.pool_address); `recommend_slippage/sol/<mint>`.
  - "auto" values are read from the screen under the main button.
  - No blockhash feed, so the RPC is prefetched every 15 s.
- Preset fields that stay "auto" fall back to `config.js` defaults (slippage 20%, priority 0.0003, tip 0.001).

## Storage

- `chrome.storage.local`: config keys (`config.js` `DEFAULTS`), `vault`, `onboard`, `trades`, `positions`, `dxMode_axiom`.
- `chrome.storage.session`: `sk` (unlocked key while the lock is on).

## Chart line

hook.js draws the DX average buy price on Axiom's TradingView chart: same-origin blob iframe → `contentWindow.tradingViewApi.activeChart()` → `createShape(horizontal_line, { disableSave, lock })`. `createPositionLine` is not available (Trading Platform only).

Level = avg SOL price × (chart close / DX mid price), median-smoothed, so it works whether the chart shows MC or price, in USD or SOL. Data comes from the background `avgline` message (positions + `quote.spotPrice`).

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Build to `dist/` (load unpacked in `chrome://extensions`). |
| `npm run test:e2e` | Playwright with the built extension, mocked terminal pages, mocked Helius RPC/Sender. Env: `SITE=gmgn`, `LIVE=1`, `PW=<pw>`, `ORPHAN=1`, `NOMETA=1`; argv: mint protocol Buy\|Sell. Screenshots in `test/out/`. Check that `swErrors`/`popErrors`/`pageErrors` are empty. |
| `npm run test:offline` | Real background modules against `test/fixtures.json` (mainnet snapshots) for every case in `test/cases.json`: build, fake simulate, quotes. |
| `npm run simexport -- <payer> [cases.json]` | Unsigned txs for mainnet `simulateTransaction` (`sigVerify: false`). Buys need a funded payer; sells a payer holding the token. |

Release: bump the version in `build.mjs` and `package.json`, build, run both e2e variants (Axiom, `SITE=gmgn`) and the offline test.

## Gotchas

- **Sandbox RPC**
  - The dev sandbox cannot reach Solana RPC. Capture fixtures in a browser tab via `solana-rpc.publicnode.com`, then merge them with `test/ingest.py`.
  - publicnode limits: max 10 keys per `getMultipleAccounts`; `getTransaction` needs `maxSupportedTransactionVersion: 1` (v1 txs exist); indexed methods such as `getTokenAccountsByOwner` are blocked.
  - The Axiom page CSP blocks fetches to RPCs, so use a separate tab.
- **Build:** `util` is aliased to `src/util-shim.js` for the browser build only (cp-amm-sdk needs it). Node test bundles must not use the alias.
- **Venue states**
  - DBC: `state.getPool` returns `{ poolState }`. A completed but not migrated curve rejects swaps (`PoolIsCompleted`).
  - LaunchLab status: 0 trading, 1 complete (migration pending), 2 migrated.
  - CPMM reserves = vault balance − protocol/fund/creator fees. The creator fee applies only if `enableCreatorFee`, on the input side per `feeOn` (0 both, 1 token0, 2 token1).
- **Slippage errors:** pump `TooMuchSolRequired`/`TooLittleSolReceived`; exact-in buys `BuySlippageBelowMin*`; PumpSwap `ExceededSlippage`.
- **Sender:** `skipPreflight`, `maxRetries: 0`; the same signed tx is re-sent every 300 ms up to 3 times (~1 s) until its signature is seen (`trade.js` `rebroadcast`). Same signature, so it lands at most once; min-out still bounds the price. Free plan: Sender 50 req/s and 0 credits; RPC 10 req/s and 1M credits/month (page watching dominates usage).
- **Orphaned tabs:** after reloading the extension, open terminal tabs are orphaned until refreshed (content shows a toast; the popup offers a tab refresh).
- **Wallet sharing:** DX and the user's Axiom wallet can be the same key, so Axiom's UI also shows DX trades.
