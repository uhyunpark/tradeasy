// UI language (Korean / English), shared by the popup, content script and background.
// Korean text is the key: T('한국어 {x}', { x }) returns the English entry from i18n-en.js when the language is
// English. Missing entries fall back to Korean. `test/i18n-check.mjs` lists keys without an English entry.
(function (g) {
  const EN = g.TE_I18N_EN || {};
  const detect = () => (/^ko\b/i.test((g.navigator && g.navigator.language) || '') ? 'ko' : 'en');
  let lang = detect();
  const listeners = [];
  const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)) : s);
  const T = (ko, v) => fill(lang === 'en' && EN[ko] != null ? EN[ko] : ko, v);

  // static markup (popup.html): translate text nodes and title/placeholder/aria-label in place, keeping the Korean original
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const tx = (orig) => {
    const key = orig.trim();
    if (!key || EN[key] == null) return orig;
    return lang === 'en' ? orig.replace(key, EN[key]) : orig;
  };
  function dom(root) {
    if (!root || !g.document) return;
    const w = g.document.createTreeWalker(root, 4 /* SHOW_TEXT */);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.__ko == null) { if (EN[n.nodeValue.trim()] == null) continue; n.__ko = n.nodeValue; }
      n.nodeValue = tx(n.__ko);
    }
    root.querySelectorAll('[' + ATTRS.join('],[') + ']').forEach((el) => {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const k = 'ko' + a.replace(/-./g, (m) => m[1].toUpperCase()).replace(/^./, (c) => c.toUpperCase());
        if (el.dataset[k] == null) { if (EN[el.getAttribute(a).trim()] == null) continue; el.dataset[k] = el.getAttribute(a); }
        el.setAttribute(a, tx(el.dataset[k]));
      }
    });
    if (g.document.documentElement) g.document.documentElement.lang = lang;
  }

  async function init() {
    try { const s = await chrome.storage.local.get('lang'); if (s.lang === 'ko' || s.lang === 'en') lang = s.lang; } catch (_) {}
    return lang;
  }
  try {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'local' || !c.lang) return;
      lang = c.lang.newValue === 'ko' || c.lang.newValue === 'en' ? c.lang.newValue : detect();
      listeners.forEach((f) => { try { f(lang); } catch (_) {} });
    });
  } catch (_) {}

  g.TE_I18N = {
    T, dom, init, EN,
    get lang() { return lang; },
    setLang: (l) => chrome.storage.local.set({ lang: l === 'en' ? 'en' : 'ko' }),
    onChange: (f) => listeners.push(f),
  };
})(globalThis);
