<p align="center"><img src="web/public/favicon.svg" width="72" alt="Piupiu" /></p>

<h1 align="center">Piupiu</h1>

<p align="center">A desktop trading terminal for Binance Agentic Wallet on BNB Chain.</p>

<p align="center">
  <a href="https://piupiuagent.xyz">Website</a> ·
  <a href="https://piupiuagent.xyz/#download">Download</a> ·
  <a href="docs/self-hosting.md">Self-hosting</a> ·
  <a href="https://x.com/anglee0323">X</a> ·
  <a href="https://t.me/PIUPIUAGENT">Telegram</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

Piupiu runs a local gateway on your computer and a web interface on top of it. It tracks new launches on Flap, Four and Gang, places trades through the Binance Agentic Wallet CLI (`baw`), and runs your automations locally. Every trade is signed on Binance's side; Piupiu never holds a private key.

> Piupiu connects to a wallet with real funds and has not been audited by a third party. Start in quote-only mode and trade small. Nothing here is investment advice.

## Features

- Trenches and trending boards across Flap, Four and Gang, with per-column presets and filters
- Token page with chart, on-chain trades, trader PnL and the Binance security audit
- Market, limit, DCA, tiered take-profit / stop-loss; up to 8 wallets per order
- Sniper, copy trading, auto-claim and auto-transfer, all off by default and capped
- Opportunity radar for mints that `.ai` wallets are joining, with pre-checked one-click minting
- Wallet tracking, portfolio and NFTs; Chinese and English; light and dark themes

## Install

Download the installer for macOS (Apple silicon / Intel) or Windows 10 / 11 from the [website](https://piupiuagent.xyz/#download). It bundles its runtime, installs `baw` on first launch and updates itself through signed releases.

## Open-source build

This repository is the open-source build of Piupiu. It charges **no trading fee** and ships **no data-source addresses**: you configure your own RPC nodes, market-data and platform APIs in `.env` (see the [self-hosting guide](docs/self-hosting.md#5-数据源)). It does not auto-update. The [installer](https://piupiuagent.xyz/#download) is the ready-to-use build: data sources included, signed updates, and a 0.5% trading fee.

## Run from source

Requires Node.js 20+, a verified Binance account with an Agentic Wallet (developer mode on) and the `baw` CLI.

```bash
git clone https://github.com/anglee0323/piupiu.git && cd piupiu
npm install && npm run web:build
cp .env.example .env    # then set RPC_URL (a BSC node) in .env
npm run quote:8788   # live market data, quote only; open http://127.0.0.1:8788
```

You will need to configure your own RPC nodes and optional data services. See the [self-hosting guide](docs/self-hosting.md) for configuration, run modes, data, security and upgrades.

## Development

```bash
npm run web:dev         # interface dev server, API proxied to 8788
npm test                # unit tests (never call the real wallet or touch real data)
npm --prefix web run build
node scripts/smoke.mjs  # simulated smoke test
```

Layout: `server.js` (gateway), `engine/live/` (markets, execution, automation), `engine/live/radar/` (radar), `shared/` (code shared by gateway and interface), `web/` (React interface), `desktop/` (Electron shell and signed updates). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (pull requests are accepted from GPT‑6 Astra or Claude Opus) and [AGENTS.md](AGENTS.md) for the conventions. Report security issues privately as described in [SECURITY.md](SECURITY.md). Commercial licensing: contact@piupiuagent.xyz.

## License

[Piupiu Community License](LICENSE), based on Apache 2.0: free for personal and non-commercial use, including modification; unmodified source may be used commercially; commercial distribution or paid services built on a modified version need a commercial license.

Built on [bnbxcs/TMTN](https://github.com/bnbxcs/TMTN), with ideas from [jacke-pp/ai-wallet-binance](https://github.com/jacke-pp/ai-wallet-binance) and [0xquqi/EZbot-agentic-wallet](https://github.com/0xquqi/EZbot-agentic-wallet). Third-party notices are in [NOTICE](NOTICE). Not affiliated with Binance, GMGN, Flap, four.meme or gang.fun.
