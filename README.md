# Tradeasy

Chrome extension for trading on Axiom and GMGN with their own UI and presets, while trades are signed by the extension's wallet and sent through Helius. No terminal fee.

- Axiom: press the usual buy and sell buttons
- GMGN: Tradeasy badge next to the buy and sell buttons
- Simulation by default; switch to LIVE in the popup for real trades

## Install

```bash
npm install
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose Load unpacked and select `dist/`. The popup walks you through wallet and Helius API key setup.

## Caution

This is a hot wallet: keep only small amounts in it. Using it may conflict with the terminals' terms of service.

Development notes: [CLAUDE.md](CLAUDE.md)
