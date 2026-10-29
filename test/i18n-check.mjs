// Lists UI text without an English entry: T('...') keys in the scripts, error sentences, and Korean text in popup.html.
// Run: node test/i18n-check.mjs
import { readFileSync, readdirSync } from 'node:fs';
globalThis.globalThis = globalThis;
await import('../src/i18n-en.js');
const EN = globalThis.TE_I18N_EN;
const H = /[가-힣]/;
const keys = new Set();
const files = ['src/popup.js', 'src/content.js', ...readdirSync('src/background').map((f) => `src/background/${f}`)];
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/T\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  if (f.endsWith('errors.js')) for (const m of s.matchAll(/^\s*(?:\[\/.*?\/i, )?'((?:[^'\\\n]|\\.)*)'\],?$/gm)) if (H.test(m[1])) keys.add(m[1]);
}
const body = readFileSync('src/popup.html', 'utf8').split('<body')[1];
for (const m of body.matchAll(/>([^<>]+)</g)) { const t = m[1].trim(); if (t && H.test(t)) keys.add(t); }
for (const m of body.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)) { const t = m[1].trim(); if (H.test(t)) keys.add(t); }
const missing = [...keys].filter((k) => EN[k] == null);
console.log(missing.length ? `missing ${missing.length}:\n` + missing.join('\n') : `ok: ${keys.size} keys translated`);
process.exit(missing.length ? 1 : 0);
