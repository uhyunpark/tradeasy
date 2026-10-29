import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';

const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: ['src/background/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outfile: `${out}/background.js`,
  inject: ['src/shims.js'],
  alias: { util: './src/util-shim.js' },
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser', 'import'],
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
});

for (const f of ['hook.js', 'content.js', 'popup.html', 'popup.js', 'i18n.js', 'i18n-en.js']) copyFileSync(`src/${f}`, `${out}/${f}`);

writeFileSync(`${out}/manifest.json`, JSON.stringify({
  manifest_version: 3,
  name: 'Tradeasy (dev)',
  version: '0.23.1',
  description: 'Trade pump.fun, PumpSwap, Meteora DBC/DAMM v2 and Raydium LaunchLab/CPMM from Axiom / GMGN with your own wallet via Helius Sender.',
  permissions: ['storage', 'activeTab', 'favicon'],
  host_permissions: ['https://axiom.trade/*', 'https://gmgn.ai/*', 'https://*.helius-rpc.com/*', 'https://api.jup.ag/*'],
  background: { service_worker: 'background.js', type: 'module' },
  content_scripts: [
    { matches: ['https://axiom.trade/*', 'https://gmgn.ai/*'], js: ['hook.js'], run_at: 'document_start', world: 'MAIN' },
    { matches: ['https://axiom.trade/*', 'https://gmgn.ai/*'], js: ['i18n-en.js', 'i18n.js', 'content.js'], run_at: 'document_start' },
  ],
  action: { default_popup: 'popup.html', default_title: 'Tradeasy' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
}, null, 2));
console.log('built', out);
