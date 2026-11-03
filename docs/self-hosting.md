# 自部署（从源代码运行）

> 只想使用 Piupiu？请直接[下载安装包](https://piupiuagent.xyz/#download)：安装包自带运行环境、首次启动自动准备组件、经发布者签名的自动更新，扫码登录即可使用。
> 本文面向需要自行审阅、构建与部署的开发者。自部署需要自己准备运行环境、钱包命令行、链上节点与数据源（开源版不内置任何数据源地址），并自行负责升级与安全。

- [1. 前提条件](#1-前提条件)
- [2. 获取与构建](#2-获取与构建)
- [3. 币安钱包命令行（baw）](#3-币安钱包命令行baw)
- [4. 链上节点（RPC）](#4-链上节点rpc)
- [5. 数据源](#5-数据源)
- [6. 环境变量](#6-环境变量)
- [7. 启动与运行模式](#7-启动与运行模式)
- [8. 数据目录与备份](#8-数据目录与备份)
- [9. 安全](#9-安全)
- [10. 升级](#10-升级)
- [与安装包的区别](#与安装包的区别)
- [常见问题](#常见问题)

## 1. 前提条件

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS、Linux 或 Windows 10 / 11（macOS 为主力平台；Windows 与 Linux 由 CI 验证构建与模拟盘冒烟） |
| Node.js | 20 或更高，推荐 22 LTS（CI 使用 22） |
| 币安账号 | 已完成身份认证，在币安 App 中开通 **Agentic Wallet** |
| 开发者模式 | 在币安 App 的 Agentic Wallet 设置中开启（内盘交易走合约调用，必须开启；有有效期，到期需续） |
| Agent ID | 交易 Agent 专属代币、参与 Agent 专属铸造需要 `.ai` Agent ID |
| 网络 | 能访问 `www.binance.com`（钱包登录与下单）、BSC 节点、各发射台接口 |

## 2. 获取与构建

```bash
git clone https://github.com/anglee0323/piupiu.git
cd piupiu
npm install              # 后端依赖
npm run web:build        # 安装界面依赖并构建（含 hooks 检查与类型检查），产物在 web/dist，由后端直接托管
cp .env.example .env     # 配置文件，见第 6 节
```

## 3. 币安钱包命令行（baw）

所有签名都经币安官方的钱包命令行 `@binance/agentic-wallet`（`baw`）完成，签名在币安侧进行，Piupiu 不接触私钥。

```bash
npm i -g @binance/agentic-wallet
baw --version
```

- **版本**：只支持核对过的版本，列表见 [`engine/live/runtime/manifest.json`](../engine/live/runtime/manifest.json)（`baw.supported`）。多钱包依赖对 baw 凭证存储方式的适配（[`engine/live/baw-profile/hook.mjs`](../engine/live/baw-profile/hook.mjs)），未核对的版本会拒绝启用多钱包。
- **路径**：找不到 `baw` 时，用 `BAW_BIN` 指定。Windows 上 npm 全局安装的是 `.cmd` 垫片，可以把 `BAW_BIN` 指到包内 `dist/index.js` 的完整路径。
- **登录**：启动后在页面右上角「连接钱包」，用币安 App 扫码并核对配对码。
- **钥匙串**：开发模式下钱包 1 的登录凭证存在系统钥匙串（macOS 会请求授权）；钱包 2 起按槽位使用独立的命名空间与会话目录。
- **Four 专属模板报价**（可选）：需要官方技能里的报价脚本：

  ```bash
  npx skills add binance/binance-skills-hub --skill binance-agentic-wallet
  ```

  默认在 `.agents/` 与 `~/.claude/skills/` 中查找，也可以用 `OPENFOUR_SCRIPT` 指定路径。

## 4. 链上节点（RPC）

开源版**不内置任何节点地址**。行情、追踪、雷达扫块、下单确认都依赖 BSC 节点，至少要配置 `RPC_URL`。

| 变量 | 用途 | 要求 |
|---|---|---|
| `RPC_URL` | 读链、下单确认（必填） | BSC 主网 JSON-RPC |
| `RPC_PUBLIC` | 行情读取、雷达分析的备用节点，逗号分隔 | 同上；多个时出错自动轮换 |
| `RPC_LOGS` | 扫发射台事件、钱包追踪回补 | 支持 `eth_getLogs`（每次约 4,500 块） |
| `WSS_URL` | 新区块与事件订阅 | WebSocket（`eth_subscribe`） |
| `NODEREAL_RPC` / `NODEREAL_KEYS` | NodeReal 私有节点（可选），多个 key 轮换 | 默认只给下单用：`NODEREAL_SCOPE=trade`；`all` 时行情也用；`NODEREAL_MONTHLY_CU` 设每月上限 |
| `FOUR_LOG_RPC` / `NAME_RPC` | 单独指定扫 Four 事件、解析名字用的节点 | 可选 |

- 公共节点限流严重：行情延迟、雷达跳块、确认变慢。需要稳定交易时请使用自己的节点。
- 密钥只放在 `.env`，界面与日志只显示编号，不显示 key。

## 5. 数据源

开源版不内置任何数据接口地址，全部在 `.env` 中配置（变量列表见 [`.env.example`](../.env.example)）。没有配置的数据源，对应功能关闭，其余功能不受影响。

| 变量 | 用途 | 接口要求 |
|---|---|---|
| `DEXSCREENER_API` | 已开盘代币的价格、市值、流动性、交易对 | 兼容 DexScreener 公共 API（`/latest/dex/tokens/…`、`/tokens/v1/bsc/…`） |
| `GECKOTERMINAL_API` | 外盘 K 线 | 兼容 GeckoTerminal API v2（`/api/v2/networks/bsc/pools/…/ohlcv/minute`） |
| `BINANCE_API` | BNB 美元价格、历史价格 | 兼容币安现货行情 API（`/api/v3/ticker/price`、`/api/v3/klines`） |
| `BINANCE_WEB3_API` | 代币安全审计 | 币安 Web3 钱包的审计接口 |
| `GANG_API` | gang.fun 新盘、行情、押金 | gang.fun 的公开 API |
| `SHRINE_API` / `SHRINE_WS` | Flap / Four 新盘与成交推送 | Shrine 的 BNB 链接口与 WebSocket |
| `FSI_API` | Flap 打新数据 | FSI 接口 |
| `FOUR_STATIC` | four.meme 代币图片与元数据 | four.meme 静态资源域名 |
| `IPFS_GATEWAYS` / `ARWEAVE_GATEWAY` | 代币与 NFT 元数据、图片，逗号分隔 | 标准 IPFS / Arweave 网关（`<网关>/ipfs/<cid>`） |
| `SPACEID_API` | 钱包的 `.bnb` / `.ai` 名字 | SPACE ID 名字接口 |
| `OPENCHAIN_API` / `FOURBYTE_API` | 雷达：合约函数名 | 函数签名库 |
| `SOURCIFY_API` | 雷达：已验证的合约源码 | Sourcify API v2 |
| `TRANSLATE_API` | 雷达：合约说明翻译成中文 | 翻译接口 |
| `X_SEARCH_API` + `CRAWLERHUB_API_KEY` | 雷达：X 上的讨论、官方账号识别 | 兼容 twitterapi.io 的搜索接口；按次消耗你自己的额度 |
| `FXTWITTER_API` | 单条推文预览 | FxTwitter 兼容接口 |

各接口的服务条款与限流由提供方决定，请自行确认并遵守。

## 6. 环境变量

完整列表与说明见 [`.env.example`](../.env.example)。常用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MODE` | `sim` | `sim` 模拟盘；`live` 实盘行情 |
| `PORT` | `8787` | 服务端口（只监听本机） |
| `LIVE_TRADE` | `0` | `1` 才会真实下单；`0` 只报价 / 预演 |
| `MAX_TRADE_BNB` | `0.5` | 单笔买入上限初始值（页面修改后以页面为准） |
| `NODEREAL_RPC` / `NODEREAL_KEYS` | 空 | 私有节点，见第 4 节 |
| `RPC_URL` / `RPC_PUBLIC` / `RPC_LOGS` / `WSS_URL` | 空 | 节点，见第 4 节（`RPC_URL` 必填） |
| 数据源变量 | 空 | 见第 5 节 |
| `BAW_BIN` | `baw` | 钱包命令行路径 |
| `CRAWLERHUB_API_KEY` | 空 | X 数据接口的 key，见第 5 节 |
| `PIUPIU_PROXY` | 跟随系统代理 | 钱包命令行使用的代理；`off` 强制直连，`http://host:port` 手动指定（只支持 HTTP / HTTPS 代理） |
| `TMTN_API_TOKEN` | 随机生成 | 本地写接口的访问令牌（存于 `data/api-token`） |
| `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | 空 | 额外允许的主机名 / 页面来源 |
| `DATA_DIR` | `data/` | 数据目录 |
| `IMG_CACHE_MAX_MB` | `400` | 头像缓存上限 |

## 7. 启动与运行模式

| 命令 | 行情 | 下单 | 用途 |
|---|---|---|---|
| `npm run sim:8787` | 模拟 | 不连接钱包 | 熟悉界面 |
| `npm run quote:8788` | 实盘 | 只报价，不上链 | 验证流程（建议先用这个） |
| `npm run live:8788` | 实盘 | 真实下单 | 正式使用 |
| `npm start` | 按 `.env` | 按 `.env` | 常规启动 |

打开 `http://127.0.0.1:<端口>`。右下角显示「演示模式」时下单不会成交。

后台需要一直运行：条件单、狙击、跟单、自动领取与转出只在后台运行时生效。可以用 pm2、systemd 或 launchd 自行守护进程。

## 8. 数据目录与备份

运行数据都在 `DATA_DIR`（默认 `data/`，已在 `.gitignore` 中），包括设置、订单日志、持仓与成本、条件单、追踪列表、雷达分析与铸造记录、多钱包槽位。

- 每天自动备份到 `backups/`（保留 14 份，不含图片缓存与可重新获取的缓存）。
- `data/radar/mints.jsonl` 是只追加的日志，不要手动改写或截断。
- 迁移到新电脑：复制整个数据目录即可，钱包需要重新扫码登录。

## 9. 安全

- **只监听本机**：服务绑定 `127.0.0.1`，不要通过反向代理或端口转发暴露到公网。
- **写接口防护**：下单、设置、转出等接口只接受本页面同源请求或带 `x-tmtn-token` 的请求；`Host` 只认本机名（防 DNS 重绑定）。
- **先只报价**：首次使用请用 `quote:8788` 验证，再小额启用 `LIVE_TRADE=1`。
- **自动化默认关闭**：狙击、跟单、条件单、自动转出、一键直铸、自动铸造都需要本人开启，并设有上限；底栏「自动化」集中显示运行状态。
- **钱包设置**：建议在币安 App 中为自动化使用的钱包设置单笔与每日额度；代币转出的收款地址需要在币安 App 的地址簿中。
- **凭据**：`.env`、`data/` 不要提交到任何仓库；不要在日志、截图中泄露 RPC key 或 API key。

## 10. 升级

自部署没有自动更新：

```bash
git pull
npm install
npm run web:build
# 重启后台
```

升级前建议备份数据目录。`baw` 升级前先确认新版本在支持列表中。

## 与安装包的区别

| | 安装包 | 自部署 |
|---|---|---|
| 运行环境 | 自带（无需安装 Node.js） | 自行安装 Node.js |
| 钱包命令行 | 首次启动自动安装锁定版本并校验 | 自行安装并保持在支持列表内 |
| 登录凭证 | 存在用户目录的独立文件中，不弹系统钥匙串 | 钱包 1 使用系统钥匙串 |
| 更新 | 经发布者签名的自动更新，失败自动退回 | 手动拉取、构建、重启 |
| 节点与数据源 | 内置 | 自行配置（见第 4、5 节） |
| 交易手续费 | 0.5%（失败不收，铸造免费） | 不收 |
| 进程守护 | 窗口打开即运行 | 自行守护 |

## 常见问题

**扫码登录超时（`REQUEST_TIMEOUT … www.binance.com:443`）**：钱包命令行连不上币安。确认网络可以访问币安；使用代理软件时请开启系统代理，或用 `PIUPIU_PROXY` 指定 HTTP 代理。

**Four 代币无法报价**：报价脚本没有找到，按第 3 节安装，或用 `OPENFOUR_SCRIPT` 指定路径。

**雷达经常「跳到最新」**：公共节点跟不上出块，属正常现象；会漏掉部分区块里的候选。

**内盘交易提示需要开发者模式**：在币安 App 的 Agentic Wallet 设置中开启开发者模式，注意有效期。
