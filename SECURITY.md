# Security policy

Piupiu places real trades through the Binance Agentic Wallet. Please report vulnerabilities privately so they can be fixed before they are public.

## How to report

Email **security@piupiuagent.xyz** with:

- what is affected (version shown in Settings → Appearance → Version, or the commit),
- how to reproduce it, and what an attacker could achieve,
- any proof of concept — using a test wallet with no funds.

Do not open a public issue or pull request for a vulnerability, and never include seed phrases, login QR codes, API keys or real wallet addresses. We aim to reply within 3 days and will credit you in the fix unless you prefer otherwise.

## In scope

- Anything that could make the gateway sign or send a transaction the user did not ask for.
- Bypassing the local API protections (same-origin / token checks, host allow-list) or exposing the gateway beyond `127.0.0.1`.
- Leaking wallet credentials, session data or other local data.
- Tampering with signed updates (manifest signature, package checksum).
- Fee handling that charges more than documented.

## Out of scope

- Losses from market risk, token contracts or third-party launchpads.
- Issues in the Binance Agentic Wallet, its CLI or Binance services — report those to Binance.
- Self-hosted deployments exposed to the internet against the guidance in `docs/self-hosting.md`.

---

安全问题请发邮件到 **security@piupiuagent.xyz**（不要公开提 Issue）。说明受影响的版本、复现步骤和可能的后果；如需演示，请使用没有资金的测试钱包，不要附带助记词、登录二维码、密钥或真实钱包地址。我们会在 3 天内回复。
