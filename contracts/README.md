# 合约

## PiupiuFee.sol（交易手续费收款）

收到的 BNB 当场全额转给 `treasury`，合约不留钱、不碰代币、没有管理员；`treasury` 部署时写死，之后无法修改。
Gateway 在成交后调用 `pay(bytes32 ref)` 付手续费（`engine/live/fees.js`），`ref` 是所含订单编号的 keccak256，便于对账。

### 部署（Remix）

1. 打开 https://remix.ethereum.org ，新建 `PiupiuFee.sol`，粘贴本目录同名文件内容。
2. Solidity Compiler：版本 `0.8.24`；Advanced Configurations 里勾选 Optimization，runs `200`，EVM Version 选 `paris`。点 Compile。
3. Deploy & Run：Environment 选 Injected Provider（钱包切到 BNB Smart Chain），合约选 `PiupiuFee`，
   构造参数 `treasury_` 填收款钱包 `0xAD11aE703dFfDED3ad7caE72871BDCD44EF58CA2`，点 Deploy 并在钱包里确认（网络费很低，钱包里有 0.001 BNB 足够）。
   部署用的钱包对合约没有任何权限。
4. 把合约地址填进 `engine/live/fees.js` 的 `FEE_CONTRACT`，跑 `node scripts/check-fee-contract.mjs <地址>` 核对链上字节码与本地编译一致、`treasury()` 正确。

### 在 BscScan 公开源码

Verify & Publish → Solidity (Single file)，编译器 `v0.8.24+commit.e11b9ed9`，MIT，Optimization Yes / 200，EVM `paris`，
构造参数（ABI 编码）：`000000000000000000000000ad11ae703dffded3ad7cae72871bdcd44ef58ca2`

### 测试

本地测试链（ganache）上测过：全额转给 treasury、合约余额为 0、`Paid` 事件、0 金额 / 直接转账 / treasury 为 0 都拒绝；`pay` 约 33,000 gas。


## PiupiuFeeV2.sol（Agent ID 持有者的手续费收款）

**BSC 主网：`0xC6D56b73ba069CA31f49858F5c91e4d71C0c4645`**（BscScan 已验证）｜部署交易 `0x827991fcfebb7655a742b9a23f7dbc847c5e102a1379c6a714b946a8eee3e529`，区块 134733776

和 V1 一样「收到即全额转给 `treasury`」，多一道链上检查：付款钱包必须持有 Agent ID（`0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`，`balanceOf > 0`），否则 `pay` 以 `NoAgentId` 回滚。
`holdsAgentId(address)` 可只读查询。没有 Agent ID 的钱包继续付 V1，行为不变；客户端按钱包身份选合约（`engine/live/fees.js` 的 `payTo()`，身份没查清时走 V1）。

**Owner 权限披露**：无 owner；无增发、无改费率、无暂停、无冻结、无提走用户资产的入口；不接收任何代币授权；不可升级；`treasury` 部署时写死为 `0xAD11aE703dFfDED3ad7caE72871BDCD44EF58CA2`，之后谁都无法修改。部署者对合约没有任何权限。

验证参数：`v0.8.24+commit.e11b9ed9` / Optimization 200 / EVM `paris` / MIT；构造参数 `000000000000000000000000ad11ae703dffded3ad7cae72871bdcd44ef58ca2`。
部署、验证、退回部署钱包余额都用 `scripts/deploy-fee-v2.mjs`；合约测试见 `contracts/test/PiupiuFeeV2.test.mjs`（ganache，10 项）。


## PiupiuPass.sol（Agent ID 持有者的免费通行证）

**BSC 主网：`0x7Ff80cDcf465c19deCe061a509c8B5444Ddf9B77`**（BscScan 已验证）｜部署交易 `0x907dd74869f92a6346127a2e6b4cad026ea2598c70b959489569b16853e2aece`，区块 134746280

一枚不可转让的 ERC-721 通行证（同时实现 ERC-5192 锁定）：钱包持有 Agent ID（`0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`，`balanceOf > 0`）才能调用 `claim()`，一个地址一枚，领取免费、只付网络费。
没有 Agent ID 以 `NoAgentId` 回滚，重复领取以 `AlreadyClaimed` 回滚。所有 `transferFrom` / `safeTransferFrom` / `approve` / `setApprovalForAll` 一律以 `Soulbound` 回滚。
图片（SVG）和元数据（`tokenURI`）由合约在链上生成，不依赖外部存储。它只是一枚徽章，不附带任何收益或其他权益；Piupiu 的任何功能都不依赖它。

**Owner 权限披露**：无 owner；无增发（只有持有者本人能为自己领取）；无升级、无暂停、无改规则、无提走资产的入口；不收款（没有 payable 函数，也不接收 BNB）；不接收任何代币授权。部署者对合约没有任何权限。

验证参数：`v0.8.24+commit.e11b9ed9` / Optimization 200 / EVM `paris` / MIT；无构造参数。
部署、验证、退回部署钱包余额都用 `scripts/deploy-pass.mjs`；合约测试见 `contracts/test/PiupiuPass.test.mjs`（ganache，21 项）。让 AI Agent 领取的说明见 `docs/PIUPIU-PASS-SKILL.md`。
