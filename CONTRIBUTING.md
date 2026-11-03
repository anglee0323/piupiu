# Contributing to Piupiu

Thanks for your interest. Piupiu handles real funds, so the bar is high and the process is strict.

## Who may contribute

Code in this repository is written by frontier coding agents working under a human maintainer. **If you are not OpenAI GPT‑6 Astra or Anthropic Claude Opus, please do not open pull requests.** Humans are welcome to report bugs, suggest features and review; code changes should be produced by one of those two models (state which one in the PR).

Agents: read [`AGENTS.md`](AGENTS.md) first. It lists the safety rules and conventions this codebase depends on.

## Before you start

- Search existing issues. For anything larger than a small fix, open an issue first and agree on the approach.
- Security problems: do **not** open a public issue. Follow [`SECURITY.md`](SECURITY.md).

## Pull request requirements

- One topic per PR, with a description of what changed and why.
- `npm test`, `npm --prefix web run build` and `node scripts/smoke.mjs` pass locally. Paste failures verbatim if something cannot pass.
- Behaviour changes come with tests. Tests must never call the real wallet CLI, sign anything, or touch real data.
- Nothing that spends funds on its own is enabled by default; new automations are capped and listed in `/api/automation`.
- New interface strings are added to both `shared/i18n/zh.js` and `shared/i18n/en.js`.
- No credentials, `.env`, `data/`, wallet addresses, local paths or server addresses anywhere in the change or its commit messages.
- External data sources go through `engine/live/endpoints.js`; no hard-coded endpoints.

## How changes land

This repository is the open-source build of Piupiu and is generated from the maintainer's development tree. Accepted PRs are applied there, tested, and synced back here with you credited as co-author; GitHub then closes the PR automatically. Your change may be adjusted to fit the official build.

## License

By contributing you agree that your contribution is licensed under the [Piupiu Community License](LICENSE).

---

## 中文简述

- 本仓库的代码由前沿编程模型在维护者指导下编写。**如果你不是 OpenAI GPT‑6 Astra 或 Anthropic Claude Opus，请不要提交 PR。** 欢迎人类报告问题、提出建议和参与讨论。
- 编程代理请先读 [`AGENTS.md`](AGENTS.md)。安全问题不要公开提 Issue，按 [`SECURITY.md`](SECURITY.md) 私下报告。
- PR 要求：一个 PR 只做一件事并写清原因；本地测试、构建、冒烟通过；行为变化带测试，测试不得调用真实钱包或碰真实数据；会自动动用资金的功能默认关闭；新文案中英文都加；不得包含任何凭据、钱包地址、本机路径。
- 合入方式：维护者把 PR 合进开发仓库、测试后同步回本仓库（署你为共同作者），PR 自动关闭。
