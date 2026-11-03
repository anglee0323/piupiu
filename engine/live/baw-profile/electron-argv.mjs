// 桌面版用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）跑 baw 时，有两处和普通 Node 不一样，这里补齐。只在 Electron 里生效，普通 node 下什么都不做。
// 1. baw 用的命令行解析库 commander 看到 process.versions.electron，会按「打包后的 Electron 应用」解析参数（从 argv[1] 开始），
//    把 baw 自己的脚本路径当成命令，报 unknown command。标成 defaultApp，让它和普通 node 一样从 argv[2] 开始解析。
// 2. Electron 没有 secp256k1 曲线，扫码登录会失败，见 ecdh-shim.mjs。
import { installSecp256k1Shim } from './ecdh-shim.mjs';
if (process.versions.electron) {
  process.defaultApp = true;
  await installSecp256k1Shim();
}
