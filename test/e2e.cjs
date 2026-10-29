// End-to-end: load the built extension in Chromium, create a wallet in the popup,
// open a mock Axiom token page, click Tradeasy -> 0.01 -> simulate, read the toast.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const EXT = path.resolve(__dirname, '../dist');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const MINT = process.argv[2] || 'BAVYwbDmuWaECkYQKJErMCHFTb8DBkQgkqYNYdxEhS6f';
const PROTOCOL = process.argv[3] || 'Pump';
const SIDE = process.argv[4] || 'Buy';

// Axiom-like trade panel: chips are div[role=button], the market button trades on pointerdown and the
// page's handlers sit on the root (like React), so Tradeasy must stop them in the capture phase.
const page_html = `<!doctype html><html><body style="background:#111;color:#eee;font-family:sans-serif">
<div id="__next"><div style="width:360px;padding:40px 12px 12px">
  <div id="panel"><div>AMOUNT <span><input id="amt" placeholder="0.0" value=""></span>${SIDE === 'Sell' ? ' %' : ''}</div>
  <div id="chips">${(SIDE === 'Sell' ? ['25%', '50%', '100%'] : ['0.01', '0.05', '0.1']).map((v) => `<div role="button" class="chip" style="display:inline-block;padding:4px 8px;border:1px solid #444">${v}</div>`).join('')}</div>
  <button id="main" style="width:288px;height:36px;border-radius:9999px;border:0;background:#43d7a0;color:#0b0d12;font:600 14px system-ui">${SIDE === 'Sell' ? 'Sell EXPB' : `<span><span>Buy EXPB</span><img alt="" style="margin-left:4px;width:12px;height:12px;vertical-align:-1px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Ccircle cx='5' cy='5' r='5' fill='%2314f195'/%3E%3C/svg%3E"><span><span id="amtlbl">0.02</span></span></span>`}</button></div>
  <div class="row" style="margin-top:20px"><a href="/meme/7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs">row link (stale)</a> <button id="quick" style="width:152px;height:32px">Buy 0.03 SOL</button></div>
  <div class="row"><button id="quick2" style="width:152px;height:32px">Buy 0.05 SOL</button><button id="quick3" style="width:152px;height:32px">Buy 0.05 SOL</button></div>
</div></div>
<script>
window.__axiomTrades = 0; window.__axiomChip = 0;
// TradingView-like chart in a same-origin iframe (as on Axiom): records the shapes Tradeasy draws
window.__shapes = [];
const tv = document.createElement('iframe'); tv.id = 'tradingview_test'; tv.style.cssText = 'width:10px;height:10px;border:0'; document.body.appendChild(tv);
tv.contentWindow.tradingViewApi = { activeChart: () => ({
  symbol: () => 'AXIOM-CHART-V1|TOKEN|SOL|USD|1|${MINT.toUpperCase()}|',
  exportData: async () => ({ schema: [{ type: 'time' }, { type: 'value', plotTitle: 'open' }, { type: 'value', plotTitle: 'high' }, { type: 'value', plotTitle: 'low' }, { type: 'value', plotTitle: 'close' }], data: [[Date.now() / 1000, 1, 1, 1, 2800]] }),
  createShape: async (pt, opt) => { window.__shapes.push({ price: pt.price, text: opt.text }); return 'S' + window.__shapes.length; },
  getShapeById: (id) => ({ setPoints: (pts) => { window.__shapes.push({ price: pts[0].price, update: true }); } }),
  removeEntity: () => {},
}) };
// React-like fiber on the one-click button: the row's pair info lives in props (as on Axiom Discover)
document.getElementById('quick')['__reactFiber$test'] = { memoizedProps: {}, return: { memoizedProps: { pairInfo: { tokenAddress: '${MINT}', pairAddress: 'x', protocol: '${PROTOCOL}', quoteTokenAddress: 'So11111111111111111111111111111111111111112' } } } };
const root = document.getElementById('__next');
document.getElementById('amt').addEventListener('input', (e) => { const l = document.getElementById('amtlbl'); if (l) l.textContent = e.target.value; });
root.addEventListener('pointerdown', (e) => { if (e.target.closest('#main, #quick, #quick2, #quick3')) window.__axiomTrades++; });
root.addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) { window.__axiomChip++; document.getElementById('amt').value = c.textContent.replace('%', ''); } });
localStorage.setItem('settings', JSON.stringify({currentSolPresetKey:'preset1', solBuyAmountUnit:'native', solQuickSets:['0.01','0.05'], percentageQuickSets:['25','50','100'],
  solPresets:{preset1:{buy:{autoFee:false,slippage:'30',maxFeeSol:'0.1',bribeFeeSol:'0.0001',mevProtection:false,priorityFeeSol:'0.00025'},
  sell:{autoFee:false,slippage:'30',maxFeeSol:'0.1',bribeFeeSol:'0.0001',mevProtection:false,priorityFeeSol:'0.00025'}}}}));
fetch('https://sol-api2.axiom.trade/token-and-best-pair-info?tokenAddress=${MINT}');
const sw = new SharedWorker('/w.js', {name:'axiom-client-socket'});
sw.port.onmessage = (e) => { window.__axiomFrames = (window.__axiomFrames||0) + 1; };
sw.port.postMessage({kind:'hello'});
</script></body></html>`;

const gmgn_html = `<!doctype html><html><body style="background:#111;color:#eee;font-family:sans-serif">
<div style="width:360px;padding:40px 12px 12px"><div>Amount <input id="amt" value="0.03"> SOL</div>
<button style="width:100px">Buy</button>
<button id="main" style="width:291px;height:36px" onclick="window.__gmgnClicks=(window.__gmgnClicks||0)+1">${SIDE}</button></div>
<div><span>Auto</span> <span>0.00014</span> <span>&lt;0.01</span> <span>Red.</span></div>
<script>
const cfg = {autoApprove:true,openMEV:true,slippageCustom:'',slippageType:'auto',rpc:'',priorityType:'auto',priorityCustom:'0.005',autoGasMax:'0.1',tipType:'auto',tipCustom:'0.005',mevMode:'normal'};
const x1 = new XMLHttpRequest(); x1.open('GET', '/api/v1/recommend_slippage/sol/${MINT}?device_id=x'); x1.send();
const x2 = new XMLHttpRequest(); x2.open('POST', '/api/v1/mutil_window_token_info?device_id=x'); x2.setRequestHeader('content-type','application/json'); x2.send(JSON.stringify({chain:'sol',addresses:['${MINT}']}));
localStorage.setItem('tradeConfigsV12', JSON.stringify({sol:{buy:{quickAmount:[0.01,0.1,0.5,1,0.25,2,5,10],tradeConfigs:[cfg,cfg,cfg],tradeConfigIndex:0},
  sell:{quickAmount:[10,25,50,100,0,0,0,0],tradeConfigs:[cfg,cfg,cfg],tradeConfigIndex:0,sellType:'pre'}}}));
</script></body></html>`;

(async () => {
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const rpcCalls = {};
  let walletPub = null;
  let simTx = null, senderHit = false;
  await ctx.route('https://axiom.trade/**', (r) => r.request().url().endsWith('/w.js')
    ? r.fulfill({ contentType: 'text/javascript', body: `onconnect=(e)=>{const p=e.ports[0];p.onmessage=()=>{setInterval(()=>{p.postMessage({kind:'frames',socket:'main',frames:[JSON.stringify({room:'sol-v2|blockhash',content:['GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',1,1,Date.now()]})]})},500)};};` })
    : r.fulfill({ contentType: 'text/html', body: page_html }));
  await ctx.route('https://gmgn.ai/**', (r) => {
    const u = r.request().url();
    if (u.includes('/recommend_slippage/')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: { recommend_slippage: '30.0', recommend_sell_slippage: '25.0' } }) });
    if (u.includes('/mutil_window_token_info')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: [{ address: MINT, symbol: 'DIRECTOR', name: 'The Director', logo: 'https://example.invalid/x.png', pool: { exchange: process.env.EXCH || 'pump', pool_address: process.env.POOL || 'x' } }] }) });
    return r.fulfill({ contentType: 'text/html', body: gmgn_html });
  });
  await ctx.route('https://sol-api2.axiom.trade/**', (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ token: { tokenAddress: MINT, ...(process.env.NOMETA ? {} : { tokenName: 'Axiom Test Coin', tokenTicker: 'ATC' }) }, bestPairInfo: { protocol: PROTOCOL, bestPairAddress: 'x' } }) }));
  await ctx.route('https://mainnet.helius-rpc.com/**', async (r) => {
    if (r.request().url().includes('api-key=bad-key')) return r.fulfill({ status: 401, contentType: 'application/json', body: '{"jsonrpc":"2.0","error":{"code":-32401,"message":"invalid api key provided"}}' });
    const req = JSON.parse(r.request().postData());
    const one = (q) => {
      rpcCalls[q.method] = (rpcCalls[q.method] || 0) + 1;
      const ctxv = { context: { slot: 1 } };
      const acc = (k) => (fixtures[k] === undefined ? null : fixtures[k]);
      let result;
      if (q.method === 'getMultipleAccounts') result = { ...ctxv, value: q.params[0].map(acc) };
      else if (q.method === 'getAccountInfo') result = { ...ctxv, value: acc(q.params[0]) };
      else if (q.method === 'getBalance') result = { ...ctxv, value: 2e9 };
      else if (q.method === 'getSlot') result = 462289804;
      else if (q.method === 'getTransaction') result = { slot: 1, blockTime: 1, transaction: { message: { accountKeys: [{ pubkey: walletPub, signer: true, writable: true }] }, signatures: [q.params[0]] },
        meta: { err: null, fee: 5000, preBalances: [2e9], postBalances: [2e9 - 10_050_000], preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: walletPub, uiTokenAmount: { uiAmountString: '35123.5', decimals: 6, amount: '35123500000' } }] } };
      else if (q.method === 'sendTransaction') result = 'WITHDRAWSIG111111111111111111111111111111111111111111111111111111';
      else if (q.method === 'getTokenAccountsByOwner') {
        const t22 = q.params[1].programId.startsWith('Tokenz');
        const mk = (pubkey, mint, amount, lamports) => ({ pubkey, account: { executable: false, lamports, owner: q.params[1].programId, rentEpoch: 0, space: 165,
          data: { program: t22 ? 'spl-token-2022' : 'spl-token', space: 165, parsed: { type: 'account', info: { isNative: false, mint, owner: walletPub, state: 'initialized',
            tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) } } } } } });
        result = { ...ctxv, value: t22 ? [mk('K62qNmxcv33EqhDXSDchRux6oXiTBYeYJyomPP9TiAR', 'FaAsdVpur5jw9qAEeEsXnGD8626ibLSUzkTdGBAwpump', '0', 1513840)]
          : [mk('BY3FGkzn4N8k86CEdN5Rmav5wK4VtRWwZmQvD7dcg2ZG', 'FMzQfjhqGnMTB56Z6ie9Muz2BzSKbGUwB2wwS4Dqex4C', '0', 2039280), mk('5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD', MINT, '5000000', 2039280)] };
      }
      else if (q.method === 'getAssetBatch') result = q.params.ids.map((id) => ({ id, content: { metadata: { symbol: id.startsWith('FMzQ') ? 'STEVE' : '' }, files: [] } }));
      else if (q.method === 'getAsset') result = { content: { metadata: { name: 'DAS Coin', symbol: 'DAS' }, files: [] } };
      else if (q.method === 'getBlockTime') result = Math.floor(Date.now() / 1000);
      else if (q.method === 'simulateTransaction') { simTx = q.params[0]; result = { ...ctxv, value: { err: null, logs: ['mock sim'], unitsConsumed: 104000 } }; }
      else if (q.method === 'getSignatureStatuses') result = { ...ctxv, value: [{ slot: 462289806, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] };
      else if (q.method === 'getLatestBlockhash') result = { ...ctxv, value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 1 } };
      return { jsonrpc: '2.0', id: q.id, result };
    };
    r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(req) ? req.map(one) : one(req)) });
  });
  let senderUrl = null, senderBody = null, senderCount = 0;
  await ctx.route('https://sender.helius-rpc.com/**', (r) => { senderHit = true; senderCount++; senderUrl = r.request().url(); senderBody = JSON.parse(r.request().postData()); r.fulfill({ contentType: 'application/json', body: '{"jsonrpc":"2.0","id":1,"result":"SIG"}' }); });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate((l) => chrome.storage.local.set({ lang: l }), process.env.UI_LANG || 'ko');
  const swErrors = [];
  sw.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });
  const extId = sw.url().split('/')[2];

  // popup: create wallet + settings
  const pop = await ctx.newPage();
  const popErrors = [];
  pop.on('pageerror', (e) => popErrors.push(e.message));
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  // back navigation: backup -> start over (wallet removed) -> create again; lock -> backup
  const obBack = {};
  obBack.onWalletStep = await pop.isVisible('#btnObBack');
  await pop.click('#chCreate');
  await pop.waitForSelector('#vBackup:not(.hidden)', { timeout: 15000 });
  const firstPub = await pop.evaluate(() => chrome.storage.local.get('vault').then((s) => s.vault.pubkey));
  await pop.click('#btnObBack'); await pop.click('#dlgYes');
  await pop.waitForSelector('#vOnboard:not(.hidden)', { timeout: 10000 });
  obBack.walletRemoved = await pop.evaluate(() => chrome.storage.local.get('vault').then((s) => !s.vault));
  await pop.click('#chCreate');
  await pop.waitForSelector('#vBackup:not(.hidden)', { timeout: 15000 });
  obBack.newWallet = (await pop.evaluate(() => chrome.storage.local.get('vault').then((s) => s.vault.pubkey))) !== firstPub;
  await pop.check('#backupChk'); await pop.click('#btnBackupDone');
  await pop.waitForSelector('#vLockSetup:not(.hidden)', { timeout: 10000 });
  await pop.click('#btnObBack');
  await pop.waitForSelector('#vBackup:not(.hidden)', { timeout: 10000 });
  obBack.lockToBackup = true;
  obBack.keyShownAgain = (await pop.textContent('#backupKey')).length > 40;
  await pop.waitForTimeout(300);
  const backupKeyLen = (await pop.textContent('#backupKey')).length;
  const doneDisabled = await pop.isDisabled('#btnBackupDone');
  await pop.screenshot({ path: path.join(OUT, 'popup-1-backup.png') });
  await pop.check('#backupChk');
  await pop.click('#btnBackupDone');
  await pop.waitForSelector('#vLockSetup:not(.hidden)', { timeout: 10000 });
  await pop.screenshot({ path: path.join(OUT, 'popup-2-lock.png'), fullPage: true });
  if (process.env.PW) {
    await pop.fill('#lsPw', process.env.PW); await pop.fill('#lsPw2', process.env.PW + 'x'); await pop.click('#btnLockSet');
    var mismatchMsg = await pop.textContent('#lsMsg');
    await pop.fill('#lsPw2', process.env.PW); await pop.click('#btnLockSet');
  } else await pop.click('#btnLockSkip');
  await pop.waitForSelector('#vHelius:not(.hidden)', { timeout: 10000 });
  // bad key first, then a good key typed (no button press: debounce autosave)
  await pop.fill('#obKey', 'bad-key');
  await pop.click('#btnObConnect');
  await pop.waitForSelector('#obKeyStat.bad', { timeout: 10000 });
  const badStat = await pop.textContent('#obKeyStat');
  await pop.fill('#obKey', 'test-key_123');
  await pop.waitForSelector('#obKeyStat.ok', { timeout: 10000 });
  const okStat = await pop.textContent('#obKeyStat');
  await pop.screenshot({ path: path.join(OUT, 'popup-3-helius.png') });
  await pop.click('#btnObDone');
  await pop.waitForSelector('#vHome:not(.hidden)', { timeout: 10000 });
  await pop.waitForTimeout(500);
  const pubkey = await pop.textContent('#addrShort');
  walletPub = await pop.evaluate(() => chrome.storage.local.get('vault').then((s) => s.vault.pubkey));
  const todoHead = await pop.textContent('#todoHead');
  const keyStep = await pop.textContent('#stKey');
  await pop.screenshot({ path: path.join(OUT, 'popup-4-home.png') });
  await pop.click('#btnGear');
  await pop.waitForSelector('#keyStat.ok', { timeout: 10000 });
  const hlinkHiddenWhenConnected = await pop.isHidden('#vSettings .hlink');
  await pop.waitForFunction(() => /회수 가능|없습니다|못했|reclaim|Nothing|Could not/.test(document.querySelector('#accSum').textContent), null, { timeout: 10000 });
  const accBefore = (await pop.innerText('#accCard')).replace(/\s+/g, ' ');
  await pop.screenshot({ path: path.join(OUT, 'popup-5-settings.png'), fullPage: true });
  await pop.click('#btnAccClose');
  const accDialog = (await pop.innerText('#dlg .modal-card')).replace(/\s+/g, ' ');
  await pop.click('#dlgYes');
  await pop.waitForFunction(() => document.querySelector('#accMsg').textContent, null, { timeout: 15000 });
  const accounts = { accBefore, accDialog, accMsg: await pop.textContent('#accMsg') };
  let lockTest = null;
  if (!process.env.PW) {
    await pop.click('#secCard .switch');
    const panelOpen = await pop.isVisible('#lkOn');
    await pop.screenshot({ path: path.join(OUT, 'popup-5b-lock-on.png'), fullPage: true });
    await pop.fill('#nextPw', 'abcdefgh1'); await pop.fill('#nextPw2', 'abcdefgh1'); await pop.click('#btnLkOn');
    await pop.waitForTimeout(800);
    const onDesc = await pop.textContent('#secDesc'); const onMsg = await pop.textContent('#secMsg');
    await pop.screenshot({ path: path.join(OUT, 'popup-5c-lock-enabled.png'), fullPage: true });
    await pop.click('#secCard .switch'); await pop.fill('#offPw', 'wrongpass'); await pop.click('#btnLkOff'); await pop.waitForTimeout(800);
    const wrongMsg = await pop.textContent('#secMsg');
    await pop.fill('#offPw', 'abcdefgh1'); await pop.click('#btnLkOff'); await pop.waitForTimeout(800);
    lockTest = { panelOpen, onDesc, onMsg, wrongMsg, offDesc: await pop.textContent('#secDesc'), toggle: await pop.isChecked('#lockToggle') };
  }
  await pop.click('#btnBack');
  if (process.env.LIVE) { await pop.click('#modeSeg button[data-mode=live]'); await pop.waitForTimeout(250); await pop.setViewportSize({ width: 360, height: 560 }); await pop.screenshot({ path: path.join(OUT, 'popup-live-dialog.png') }); await pop.setViewportSize({ width: 1280, height: 720 }); await pop.click('#lcYes'); await pop.waitForTimeout(300); }
  const sMsg = { lockTest, doneDisabled, badStat, okStat, todoHead, keyStep, mismatchMsg: typeof mismatchMsg === 'undefined' ? null : mismatchMsg };

  // token page
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(process.env.SITE === 'gmgn' ? `https://gmgn.ai/sol/token/${MINT}` : `https://axiom.trade/meme/${MINT}`);
  await page.waitForTimeout(3500);
  const frames = await page.evaluate(() => window.__axiomFrames || 0);
  const pressAt = async (sel) => { const b = await page.locator(sel).boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
  let popText = null, toastText, rpcAtClick, axiomClicks, confirmToast = null, popAfterSynthetic = null, teMode = null;
  const lastToast = () => page.evaluate(() => { const t = document.querySelector('.te-toast.ok .bd, .te-toast.err .bd'); return t ? t.innerText.replace(/\s+/g, ' ') : null; });
  const waitToast = async (prev) => { for (let i = 0; i < 60; i++) { const t = await lastToast(); if (t && t !== prev) return t; await page.waitForTimeout(250); } return null; };
  if (process.env.SITE === 'gmgn') {
    // GMGN: Tradeasy badge -> popover -> amount
    await page.click('#te-layer .te-badge');
    await page.waitForSelector('.te-pop button[data-sol], .te-pop button[data-pct]', { timeout: 8000 });
    await page.waitForTimeout(1500); // let state load
    await page.keyboard.press('Escape');
    await page.click('#te-layer .te-badge'); // reopen with state
    await page.waitForTimeout(1400);
    popText = await page.textContent('.te-pop');
    await page.screenshot({ path: path.join(OUT, 'e2e-popover.png') });
    const target = SIDE === 'Buy' ? '.te-pop button[data-sol="0.01"]' : '.te-pop button[data-pct="50"]';
    const rpcBefore = JSON.stringify(rpcCalls);
    await page.click(target);
    toastText = await waitToast(null);
    rpcAtClick = { before: JSON.parse(rpcBefore), after: JSON.parse(JSON.stringify(rpcCalls)) };
    axiomClicks = await page.evaluate(() => window.__gmgnClicks || 0);
    if (process.env.LIVE) { await page.waitForTimeout(4000); confirmToast = await page.evaluate(() => [...document.querySelectorAll('.te-toast')].map((x) => x.innerText).join(' || ')); }
    await page.evaluate(() => document.querySelector('#te-layer .te-badge').click()); // synthetic: must not open
    await page.waitForTimeout(500);
    popAfterSynthetic = !!(await page.$('.te-pop'));
  } else {
    // Axiom: Tradeasy mode on by default -> the page's own chip and market button
    await page.waitForTimeout(1500);
    teMode = { badge: await page.getAttribute('#te-layer .te-badge', 'aria-checked'), cover: await page.isVisible('#te-layer .te-cover') };
    { const b = await page.locator('#main').boundingBox(); await page.screenshot({ path: path.join(OUT, `cover-${process.env.LIVE ? 'live' : 'sim'}.png`), clip: { x: b.x - 30, y: b.y - 30, width: b.width + 60, height: b.height + 60 } }); }
    await page.click(SIDE === 'Buy' ? '.chip >> text="0.01"' : '.chip >> text="50%"');
    teMode.inputAfterChip = await page.inputValue('#amt');
    teMode.chipReachedPage = await page.evaluate(() => window.__axiomChip);
    const rpcBefore = JSON.stringify(rpcCalls);
    teMode.cover = await page.evaluate(() => { const c = document.querySelector('#te-layer .te-cover'), m = document.getElementById('main'); const a = c.getBoundingClientRect(), b = m.getBoundingClientRect(); return { text: c.innerText, hasIcon: !!c.querySelector('img'), aligned: ['left', 'top', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 1), radius: c.style.borderRadius }; });
    await pressAt('#main'); // a real press where Axiom's button is: lands on the Tradeasy cover
    toastText = await waitToast(null);
    rpcAtClick = { before: JSON.parse(rpcBefore), after: JSON.parse(JSON.stringify(rpcCalls)) };
    if (process.env.LIVE) { await page.waitForTimeout(4000); confirmToast = await page.evaluate(() => [...document.querySelectorAll('.te-toast')].map((x) => x.innerText).join(' || ')); }
    if (process.env.LIVE) { await page.waitForTimeout(3500); teMode.avgLine = await page.evaluate(() => window.__shapes.slice(-2)); }
    // list quick buy: token from the row link
    await page.click('#quick');
    teMode.quickToast = await waitToast(toastText);
    // one-click button whose token cannot be resolved (no props, no row link): blocked, never the page token
    await page.click('#quick2');
    teMode.unknownQuickToast = await waitToast(teMode.quickToast);
    // synthetic pointerdown from page JS: blocked for the page, ignored by Tradeasy
    const before = await page.evaluate(() => document.querySelectorAll('.te-toast').length);
    await page.evaluate(() => document.getElementById('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
    await page.waitForTimeout(800);
    teMode.syntheticToasts = (await page.evaluate(() => document.querySelectorAll('.te-toast').length)) - before;
    teMode.tradesReachedPageWhileOn = await page.evaluate(() => window.__axiomTrades);
    // badge toggles Tradeasy mode off: now the page itself trades
    await page.click('#te-layer .te-badge');
    await page.waitForTimeout(300);
    teMode.badgeOff = await page.getAttribute('#te-layer .te-badge', 'aria-checked');
    { const b = await page.locator('#main').boundingBox(); await page.screenshot({ path: path.join(OUT, 'cover-off.png'), clip: { x: b.x - 30, y: b.y - 30, width: b.width + 60, height: b.height + 60 } }); }
    await page.click('#main');
    teMode.tradesReachedPageWhenOff = await page.evaluate(() => window.__axiomTrades);
    await page.click('#te-layer .te-badge'); // back on
    // popup switch writes teMode_axiom: the page follows without a reload
    await pop.evaluate(() => chrome.storage.local.set({ teMode_axiom: false }));
    await page.waitForTimeout(300);
    teMode.popupOff = { badge: await page.getAttribute('#te-layer .te-badge', 'aria-checked'), cover: await page.isVisible('#te-layer .te-cover') };
    await pop.evaluate(() => chrome.storage.local.set({ teMode_axiom: true }));
    await page.waitForTimeout(300);
    teMode.popupOn = { badge: await page.getAttribute('#te-layer .te-badge', 'aria-checked'), cover: await page.isVisible('#te-layer .te-cover') };
    axiomClicks = teMode.tradesReachedPageWhileOn;
  }
  await page.screenshot({ path: path.join(OUT, 'e2e.png') });
  { const box = await page.$('.te-toasts'); if (box) await box.screenshot({ path: path.join(OUT, process.env.LIVE ? 'toasts-live.png' : 'toasts-sim.png') }); }

  const tokCard = await pop.evaluate(async () => {
    const list = await chrome.runtime.sendMessage({ type: 'watch:get' });
    const q = chrome.tabs.query; chrome.tabs.query = async () => [{ id: list[0] && list[0].tabId }];
    await renderHome(); chrome.tabs.query = q;
    return document.querySelector('#tokState').textContent + ' | ' + document.querySelector('#tokBody').innerText.replace(/\s+/g, ' ');
  });
  const tokCardOrphan = await pop.evaluate(async () => {
    const q = chrome.tabs.query, sm = chrome.runtime.sendMessage;
    chrome.tabs.query = async () => [{ id: 999, url: 'https://gmgn.ai/sol/token/GAZcHPujTKecvFmzv4RH6zrfTGHkjwYLzx6RM3hddUeG' }];
    chrome.runtime.sendMessage = (m) => (m.type === 'watch:get' ? Promise.resolve([]) : sm.call(chrome.runtime, m));
    await renderHome(); chrome.tabs.query = q; chrome.runtime.sendMessage = sm;
    return document.querySelector('#tokState').textContent + ' | ' + document.querySelector('#tokBody').innerText.replace(/\s+/g, ' ');
  });
  // withdraw flow
  await pop.evaluate(() => { tab = 'home'; return refresh(); });
  await pop.click('#btnSendOpen');
  await pop.fill('#sendTo', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
  await pop.fill('#sendAmt', '0.1');
  await pop.click('#btnSendNext');
  await pop.waitForSelector('#sendConfirm:not(.hidden)', { timeout: 8000 });
  const sendConfirmText = (await pop.innerText('#sendConfirm')).replace(/\s+/g, ' ');
  await pop.screenshot({ path: path.join(OUT, 'popup-7-send-confirm.png') });
  await pop.click('#btnSendGo');
  await pop.waitForFunction(() => !/전송 중|Sending/.test(document.querySelector('#sdTitle').textContent), null, { timeout: 15000 });
  const sendDone = (await pop.innerText('#sendDone')).replace(/\s+/g, ' ');
  // bad address
  await pop.click('#btnSendClose'); await pop.click('#btnSendOpen'); await pop.fill('#sendTo', 'notanaddress'); await pop.fill('#sendAmt', '0.1'); await pop.click('#btnSendNext');
  await pop.waitForTimeout(500); const sendBad = await pop.textContent('#sendMsg');
  await pop.click('#btnBack');
  const withdraw = { sendConfirmText, sendDone, sendBad };
  await pop.evaluate(async () => { const q = chrome.tabs.query; chrome.tabs.query = async () => [{ id: 1, url: 'https://axiom.trade/meme/x' }]; await renderSite(); chrome.tabs.query = q; });
  await pop.screenshot({ path: path.join(OUT, 'popup-teswitch.png'), clip: { x: 0, y: 0, width: 360, height: 90 } });
  const cfgAfter = await pop.evaluate(() => chrome.storage.local.get(null).then((s) => ({ hk: s.heliusApiKey, vaultPlain: !!(s.vault && s.vault.plain) })));
  await pop.waitForTimeout(3500);
  await pop.screenshot({ path: path.join(OUT, 'popup-6-home-after.png'), fullPage: true });
  // log: old-style separate confirm entries fold in, 8 rows + "more"
  const logTest = await pop.evaluate(async () => {
    const S = (i) => 'SIG' + String(i).padStart(84, '1');
    const t = [];
    for (let i = 0; i < 11; i++) {
      t.push({ signature: S(i), side: i % 2 ? 'sell' : 'buy', confirm: { status: 'confirmed' }, at: Date.now() - i * 1000 });
      t.push({ signature: S(i), side: i % 2 ? 'sell' : 'buy', simulated: false, expected: { sol: 0.01, tokens: 1000 }, symbol: 'ATC', at: Date.now() - i * 1000 - 500 });
    }
    t.unshift({ side: 'close', signature: S(99), count: 2, failed: 0, sol: 0.0036, at: Date.now() });
    await chrome.storage.local.set({ trades: t });
    tab = 'home'; await refresh();
    const rows = document.querySelectorAll('#log > div').length, icons = document.querySelectorAll('#log a.sx').length;
    const more = document.querySelector('#logMore') && document.querySelector('#logMore').textContent;
    document.querySelector('#logMore').click(); await new Promise((r) => setTimeout(r, 300));
    return { rows, icons, more, rowsOpen: document.querySelectorAll('#log > div').length, first: document.querySelector('#log > div').innerText.replace(/\s+/g, ' ') };
  });
  await pop.screenshot({ path: path.join(OUT, 'popup-6b-log.png'), fullPage: true });
  const langSwitch = await pop.evaluate(async () => {
    const before = TE_I18N.lang;
    await TE_I18N.setLang(before === 'en' ? 'ko' : 'en'); await new Promise((r) => setTimeout(r, 400));
    const r = { before, after: TE_I18N.lang, settingsTitle: document.querySelector('#langTitle').textContent, todo: document.querySelector('#todoHead') && document.querySelector('#todoHead').textContent };
    await TE_I18N.setLang(before); await new Promise((r2) => setTimeout(r2, 400));
    r.back = document.querySelector('#langTitle').textContent;
    return r;
  });
  console.log(JSON.stringify({ obBack, langSwitch, logTest, accounts, hlinkHiddenWhenConnected, teMode, withdraw, lockTest, tokCard, tokCardOrphan, rpcAtClick, backupKeyLen, cfgAfter, pubkey, sMsg, frames, popText, toastText, axiomClicks, simTxLen: simTx && simTx.length, senderHit,
    syntheticOpenedPopover: popAfterSynthetic, senderUrl, senderCount, senderParams: senderBody && senderBody.params[1], confirmToast, rpcCalls, swErrors, popErrors, pageErrors }, null, 2));
  if (process.env.ORPHAN) {
    await page.keyboard.press('Escape');
    const badgesBefore = await page.evaluate(() => document.querySelectorAll('#te-layer .te-badge').length);
    await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await page.waitForTimeout(4000);
    const orphan = await page.evaluate(() => ({ badges: document.querySelectorAll('#te-layer .te-badge').length,
      toast: [...document.querySelectorAll('.te-toast')].map((x) => x.innerText)[0] }));
    let blockedAfterReload = null;
    if (process.env.SITE !== 'gmgn') { await pressAt('#main'); await page.waitForTimeout(300); blockedAfterReload = await page.evaluate(() => window.__axiomTrades === (window.__tradesBefore ?? window.__axiomTrades)); }
    console.log('ORPHAN', JSON.stringify({ badgesBefore, ...orphan, tradesAfterReload: await page.evaluate(() => window.__axiomTrades) }));
  }
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
