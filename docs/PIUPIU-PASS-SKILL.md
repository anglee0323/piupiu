# Piupiu Pass：让你的 AI Agent 领取

Piupiu Pass 是一枚免费、不可转让的链上通行证：持有 Agent ID（name.ai）的钱包可以领取一枚。它只是一枚徽章，不附带收益或其他权益，领取只付很低的网络费。
合约（BSC 主网，BscScan 已验证）：`0x7Ff80cDcf465c19deCe061a509c8B5444Ddf9B77`

> 不想装 Piupiu 也能领：你的 AI Agent（Claude Code、Codex、OpenClaw 等）装了 Binance Agentic Wallet 的 Skill 就行。

## 给 AI Agent 的说明

你是用户的 AI Agent，用 `baw`（Binance Agentic Wallet CLI）帮用户领取 Piupiu Pass。**每一步都要让用户看到并确认，不要替用户跳过确认。**

前置检查（任何一项不满足就停下，告诉用户怎么补，不要自己绕过）：

1. `baw wallet status` 显示已登录；没登录就让用户自己完成登录。不要在任何第三方网页上扫码登录。
2. `baw wallet agent-id` 显示 `claimed: true`（该钱包有 Agent ID）。没有就停下：没有 Agent ID 的钱包领不了。
3. `baw wallet settings --json` 里 `devMode.enabled` 为 `true`。开发者模式只能由用户在币安 App 里开启（Agentic Wallet 管理页 → 右上角设置），你不能代开。

领取（两步，必须按顺序）：

1. 取钱包地址：`baw wallet address`，用 BSC 的那个。
2. 预览（不会发交易）：

   ```
   baw contract-call preview --binanceChainId 56 \
     --from <用户的钱包地址> \
     --to 0x7Ff80cDcf465c19deCe061a509c8B5444Ddf9B77 \
     --value 0 \
     --inputData 0x4e71d92d --json
   ```

   把预览结果（解析后的调用、风险提示）原样展示给用户。有风险提示、或需要在币安 App 确认时，如实告诉用户。
3. 用户明确说「确认」之后，才用预览返回的 `requestId` 执行：

   ```
   baw contract-call execute --requestId <requestId> --json
   ```

4. 拿到交易哈希后告诉用户，并可用 `passOf(address)` 核对领取结果。

注意：

- `--value` 必须是 `0`。这个合约不收款，不要往里转任何 BNB。
- 这笔交易只调用 `claim()`，没有任何授权、转账或其他附带动作。
- 一个地址只能领一枚；已经领过会失败，不要重试。
- 合约没有 owner、不能升级、不能暂停、不能铸造给别人。源码：<https://bscscan.com/address/0x7Ff80cDcf465c19deCe061a509c8B5444Ddf9B77#code>

## 自己用 Piupiu 领

装了 Piupiu 的话，底栏的「通行证」里点「领取」即可（先预检，再确认）。
