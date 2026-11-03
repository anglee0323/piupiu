# Piupiu — guide for coding agents

Read this before changing anything. Piupiu connects to wallets with real funds; most rules below exist because something went wrong once. Also read `docs/ARCHITECTURE.md` (layers and stable contracts) and `CONTRIBUTING.md` (who may contribute and what a PR needs).

## Layout

- `server.js` + `engine/` — the local gateway. All decisions and execution live here; the interface only displays and clicks.
- `engine/live/` — markets, order execution (`liveTrader.js`), wallet CLI wrapper (`baw.js`), automations; `engine/live/radar/` — the opportunity radar.
- `shared/` — code shared by gateway and interface (filters, i18n dictionaries, capabilities). Put pure decision logic here once, never duplicate it in `web/`.
- `web/` — React interface (Vite, Tailwind). `desktop/` — Electron shell and signed updates. `contracts/` — the fee contract of the official build (unused here).

## Commands

| Task | Command |
|---|---|
| Unit tests | `npm test` |
| Interface build (hooks lint + type check) | `npm --prefix web run build` |
| Simulated smoke test | `node scripts/smoke.mjs` |
| Run, quote only (never signs) | `npm run quote:8788` |

Run tests and the build before every PR and report failures verbatim.

## Safety rules (non-negotiable)

- Never run anything that signs or sends a transaction while testing. Use `quote:8788` or `MODE=sim`. Unit tests must not reach `baw` or real data: `baw.js` refuses all calls inside the test runner, and `config.js` points `DATA_DIR` at a temporary directory there — keep it that way, and stub `send` in any test that touches execution.
- Real orders are only accepted from a manual click or an automation the user switched on (the `source` allow-list in `liveTrader.js`). Anything that can spend funds by itself must be off by default, confirmed before enabling, capped, and listed in `/api/automation`.
- When an order's outcome is unknown (timeout, network error), look it up by its id; never resend.
- External content (web pages, contract descriptions, tweets) is display text only. It must never trigger a trade or change a setting.
- Never commit credentials, `.env` or `data/`. Never put wallet addresses, local paths or server addresses in code, docs or commit messages.

## Gateway conventions

- Every external data source comes from `engine/live/endpoints.js` (`EP`), configured through environment variables (see `docs/self-hosting.md`). Do not hard-code endpoints in modules. An empty source must disable its feature, not crash the gateway.
- All wallet CLI calls go through `engine/live/baw.js`.
- Public RPC nodes rate-limit: heavy jobs use their own connection, `eth_getLogs` in chunks of at most ~4,500 blocks with pauses; a failed query with no result is not "done".
- The tick stream is incremental (`server.js` `tokenDelta`): a `full` frame first, then only changes with a continuous `seq`. Do not go back to full frames; think twice before adding large fields to token objects.
- Interface settings are stored by the gateway (`/api/prefs`). Adding a prefs field: bump `version` in `web/src/store/prefs.ts` and migrate with a `from < N` guard so each step runs once.
- Alert decisions (which sound, when) belong to `engine/live/notifier.js`; the page only plays them.
- Do not put `//` comments in the middle of a one-line object literal — everything after the comment disappears (`engine/lint.test.js` checks this).

## Interface conventions

- Root font size is 20px (`h-8` is 40px). Use the rem scale.
- Never define a component with inputs inside a render function (it remounts on every render and loses focus). Use `NumField` / `NumBox` for numbers.
- Hooks go before any early `return`.
- Popovers portal to `body` (`Hover`, `Tip`, `FilterPop`); cards and columns clip overflow.
- Settings screens use `components/SettingsKit.tsx`; toggles are `Switch`, never "on / off" text buttons or native checkboxes.
- Colours come from the theme tokens in `web/src/index.css`; a new colour goes into both `@theme` and `:root[data-theme="light"]`.
- Every user-visible string goes into both `shared/i18n/zh.js` and `en.js` (`i18n.test.js` rejects hard-coded Chinese in `web/src`). Gateway messages stay in Chinese and get a `gw.*` template (`gw.test.js` lists missing ones). Write like a finished product: concise, formal, no developer jargon.

## Pull requests

One topic per PR, a clear description of what and why, tests for behaviour changes, and the checklist in the PR template ticked. See `CONTRIBUTING.md`.
