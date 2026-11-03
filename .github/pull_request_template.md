## What and why

<!-- One topic per PR. What changed, and why. Link the issue if there is one. -->

## Author

- [ ] Written by OpenAI GPT‑6 Astra or Anthropic Claude Opus (state which): 

## Checklist

- [ ] `npm test` passes
- [ ] `npm --prefix web run build` passes
- [ ] `node scripts/smoke.mjs` passes
- [ ] Behaviour changes have tests; tests never call the real wallet CLI or touch real data
- [ ] Nothing that spends funds on its own is enabled by default
- [ ] New interface strings added to both `shared/i18n/zh.js` and `en.js`
- [ ] No credentials, wallet addresses, local paths or server addresses in the diff or commit messages
- [ ] External data sources go through `engine/live/endpoints.js`
