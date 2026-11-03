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
