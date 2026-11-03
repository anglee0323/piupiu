<p align="center"><img src="web/public/favicon.svg" width="72" alt="Piupiu" /></p>

<h1 align="center">Piupiu</h1>

<p align="center">BNB Chain 上为币安 Agentic 钱包打造的桌面交易终端。</p>

<p align="center">
  <a href="https://piupiuagent.xyz">官网</a> ·
  <a href="https://piupiuagent.xyz/#download">下载</a> ·
  <a href="docs/self-hosting.md">自部署</a> ·
  <a href="README.md">English</a>
</p>

Piupiu 在你的电脑上运行一个本机服务（Gateway），界面在它之上。它追踪 Flap、Four、Gang 的新盘，通过币安 Agentic 钱包命令行（`baw`）下单，自动化任务也在本机执行。每笔交易由币安侧签名，Piupiu 不保存任何私钥。

> Piupiu 连接真实资金钱包，代码未经第三方审计。请先用只报价模式验证，再小额使用。本项目不构成任何投资建议。

## 功能

- 战壕与热门：覆盖 Flap、Four、Gang，每列独立的预设与筛选
- 代币页：K 线、链上成交、交易者盈亏、币安安全审计
- 市价、限价、DCA、多档止盈止损；一笔订单最多 8 个钱包同时下单
- 狙击、跟单、自动领取与转出：默认关闭，设有上限
- 机会雷达：识别 `.ai` 钱包正在参与的铸造，预检后一键铸造
- 钱包追踪、资产与 NFT；中文 / English；明亮 / 黑暗主题

## 安装

从[官网](https://piupiuagent.xyz/#download)下载 macOS（Apple 芯片 / Intel）或 Windows 10 / 11 安装包。安装包自带运行环境，首次启动自动安装 `baw`，并通过签名的更新自动升级。

## 开源版

本仓库是 Piupiu 的开源版：**不收交易手续费**，也**不内置任何数据源地址**。节点、行情接口、发射台接口等需要自行在 `.env` 中配置（见[自部署说明](docs/self-hosting.md#5-数据源)），也没有自动更新。开箱即用请下载[安装版](https://piupiuagent.xyz/#download)：内置数据源、签名自动更新，收取 0.5% 交易手续费。

## 从源代码运行

需要 Node.js 20+、已完成身份认证并开通 Agentic 钱包（开启开发者模式）的币安账号，以及 `baw` 命令行。

```bash
git clone https://github.com/anglee0323/piupiu.git && cd piupiu
npm install && npm run web:build
cp .env.example .env    # 然后在 .env 中填写 RPC_URL（BSC 节点）
npm run quote:8788   # 实盘行情、只报价；打开 http://127.0.0.1:8788
```

链上节点与可选的数据服务需要自行配置。配置项、运行模式、数据、安全与升级见[自部署文档](docs/self-hosting.md)。

## 开发

```bash
npm run web:dev         # 界面开发模式，接口转发到 8788
npm test                # 单元测试（不会调用真实钱包，也不会读写真实数据）
npm --prefix web run build
node scripts/smoke.mjs  # 模拟盘冒烟
```

目录：`server.js`（Gateway）、`engine/live/`（行情、交易执行、自动化）、`engine/live/radar/`（雷达）、`shared/`（Gateway 与界面共用）、`web/`（React 界面）、`desktop/`（Electron 外壳与签名更新）。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 参与贡献

欢迎提交 Issue 与 Pull Request。提交前请运行测试与构建；新增界面文案同时加入 `shared/i18n/zh.js` 与 `en.js`；不要提交任何凭据（`.env`、`data/`、各类密钥）。

## 许可

[Piupiu Community License](LICENSE)，以 Apache 2.0 为基础：个人与非商业用途（含修改）不受限制；不修改源代码时可用于商业用途；基于修改版的商业分发或付费服务需要商业授权。

基于 [bnbxcs/TMTN](https://github.com/bnbxcs/TMTN)，参考了 [jacke-pp/ai-wallet-binance](https://github.com/jacke-pp/ai-wallet-binance) 与 [0xquqi/EZbot-agentic-wallet](https://github.com/0xquqi/EZbot-agentic-wallet)。第三方声明见 [NOTICE](NOTICE)。本项目与币安、GMGN、Flap、four.meme、gang.fun 无关联。
