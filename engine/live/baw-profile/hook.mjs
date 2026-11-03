// 多钱包（不用 Docker）：让 baw 把登录凭证存到这个钱包自己的钥匙串位置。
// baw 默认把 agentSessionId 存在系统钥匙串的全局固定位置（service "baw"），同一台电脑登录第二个账号会覆盖第一个。
// 用法：node --import <本文件> <baw 的 dist/index.js> ...，并设置
//   PIUPIU_BAW_PROFILE   钱包名（如 wallet2），钥匙串 service 变成 baw.piupiu.<名字>
//   BINANCE_BAW_DIR      这个钱包自己的会话目录（session.json 里的 clientId 也就分开了）
// 思路来自 0xquqi/EZbot-agentic-wallet（MIT）的 keytar 命名空间适配器。
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 只认核对过存凭证方式的 baw 版本：升级后先确认 dist/index.js 里还是 keytar("baw","agentSessionId") + BINANCE_BAW_DIR，再加进来
const KNOWN = new Set(['1.11.0', '1.12.0']);

const profile = process.env.PIUPIU_BAW_PROFILE || '';
if (!/^[a-z0-9-]{1,32}$/.test(profile)) throw new Error('PIUPIU_BAW_PROFILE 格式不对（小写字母、数字、横线）');
if (!process.env.BINANCE_BAW_DIR || !isAbsolute(process.env.BINANCE_BAW_DIR)) throw new Error('多钱包必须给每个钱包设置绝对路径的 BINANCE_BAW_DIR');
const cli = process.argv[1] ? realpathSync(process.argv[1]) : '';
let version = '';
try { version = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')).version; } catch { /* 下面报错 */ }
if (!KNOWN.has(version) && process.env.PIUPIU_BAW_ALLOW_ANY !== '1') {
  throw new Error(`baw 版本 ${version || '未知'} 还没有核对过多钱包隔离方式（已核对：${[...KNOWN].join(', ')}）。核对后加入 KNOWN，或临时设 PIUPIU_BAW_ALLOW_ANY=1`);
}
// 包装层通过环境变量拿到真实 keytar 的绝对路径（绝对路径不会再被下面的钩子拦截）
process.env.PIUPIU_REAL_KEYTAR = join(dirname(cli), '..', 'node_modules', '@github', 'keytar');
const wrapper = pathToFileURL(join(dirname(realpathSync(new URL(import.meta.url))), 'keytar-ns.mjs')).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@github/keytar') return { url: wrapper, shortCircuit: true };
    return next(specifier, context);
  },
});
