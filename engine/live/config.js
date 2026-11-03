// 实盘配置。合约地址 / 数据源来自参考版 agent-curve-terminal（Flap Agent Curve + shrine + fsi + 币安 Agentic Wallet）。
import { readFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_MODE, APP_HOME } from './dotenv.js';
import { setNodeRealSlots, initNodeRealBudget } from './rpc.js';
import { EP } from './endpoints.js';
// 安装版模式、用户目录和 .env 的读取在 dotenv.js（必须最先加载：endpoints.js 等模块在 config.js 之前就会读环境变量）
export { APP_MODE, APP_HOME } from './dotenv.js';
export const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);   // 空值当没填

// 开发时默认模拟盘、只报价；安装版默认实盘、真实下单（装它就是为了交易；每笔仍要用户点击，「下单前确认」默认开着）
export const MODE = env('MODE', APP_MODE ? 'live' : 'sim').toLowerCase();               // sim | live
// 默认只报价/预演。LIVE_TRADE=1 才会通过 baw 真实下单，且只接受页面上手动点击的订单（自动买/自动卖仍只报价）。
export const LIVE_TRADE = env('LIVE_TRADE', APP_MODE ? '1' : '0') === '1';
export const DRY_RUN = !LIVE_TRADE;
// 调试用：AUTH_SIMULATE_LOGGED_OUT=1 时把登录状态当成未登录（测试登录弹窗，不会真的登出）
export const AUTH_SIMULATE_LOGGED_OUT = env('AUTH_SIMULATE_LOGGED_OUT', '0') === '1';
// 单笔真实买入上限（BNB）的初始值；页面「交易设置」里改过之后以 data/live-settings.json 为准。0 = 不限
export const MAX_TRADE_BNB = Number(env('MAX_TRADE_BNB', '0.5'));
// 数据目录：默认项目里的 data/。第二个钱包的后端用 DATA_DIR 指向自己的目录（设置、持仓、规则、授权记录、耗时记录都分开）
// 单元测试进程（node --test 会设 NODE_TEST_CONTEXT）没指定 DATA_DIR 时用一个临时目录：测试绝不能读 / 写真实的 data/（订单、铸造历史、设置）。
// 2026-10-29 一个没隔离的测试把假的铸造记录追加进了真实的 mints.jsonl，所以这里统一兜底
const TEST_DATA = process.env.NODE_TEST_CONTEXT && !env('DATA_DIR', '') ? pathJoin(mkdtempSync(pathJoin(tmpdir(), 'piupiu-test-data-')), '/') : null;
export const DATA_DIR = TEST_DATA || (env('DATA_DIR', '') ? pathResolve(String(env('DATA_DIR', '')).replace(/^~(?=\/)/, homedir())) : APP_MODE ? pathJoin(APP_HOME, 'data', '/') : fileURLToPath(new URL('../../data/', import.meta.url)));
export const dataFile = (name) => pathToFileURL(pathJoin(DATA_DIR, name));
export const BAW_DIR = env('BINANCE_BAW_DIR', '');
// 本后端只允许用这个钱包地址（可选）。baw 登录成别的账号时拒绝使用，防止拿错账号下单 / 自动转出
export const EXPECT_WALLET = env('WALLET_ADDRESS', '').toLowerCase();   // baw 的登录信息目录（空 = 默认 ~/.baw）
// 只用公共节点跑行情订阅（第二个钱包的后端用，省 NodeReal 额度；交易链路照样用 NodeReal）
export const FEEDS_PUBLIC = env('FEEDS_PUBLIC', '0') === '1';
export const LIVE_SETTINGS_FILE = dataFile('live-settings.json');
// 私有节点 NodeReal（含 key，只放 .env）：NODEREAL_RPC 填一个完整地址，或 NODEREAL_KEYS 填多个 key（逗号分隔），多个 key 会轮流用、被限流时自动换
const NR_KEYS = env('NODEREAL_KEYS', '').split(',').map((k) => k.trim()).filter(Boolean);
export const NODEREAL_URLS = [env('NODEREAL_RPC', ''), ...NR_KEYS.map((k) => `https://bsc-mainnet.nodereal.io/v1/${k}`)].filter((u, i, a) => u && a.indexOf(u) === i);
export const NODEREAL_RPC = NODEREAL_URLS[0] || '';
// NodeReal 免费版每月只有 1000 万 CU（约每天 33 万，平均每秒 3.8 CU）——后台常驻的行情读取 / 链上订阅一个月都吃不完（实测 4 小时烧光）。
// 所以默认 NodeReal 只给「下单」这条延迟敏感的路径用（NODEREAL_SCOPE=trade）；行情读取、订阅、启动回补全走公共节点。
// 付费版额度充足时才设 NODEREAL_SCOPE=all，让行情也用 NodeReal。
export const NODEREAL_SCOPE = env('NODEREAL_SCOPE', 'trade') === 'all' ? 'all' : 'trade';
export const NODEREAL_BG_URLS = NODEREAL_SCOPE === 'all' ? NODEREAL_URLS : [];   // 后台（行情 / 订阅 / 回补）可用的 NodeReal
export const NODEREAL_WSS = env('FEEDS_PUBLIC', '0') === '1' ? [] : NODEREAL_BG_URLS.map((u) => u.replace(/^https:/, 'wss:').replace('/v1/', '/ws/v1/'));
setNodeRealSlots(NODEREAL_URLS);
// 月度用量保险（每个 key 各记各的）：某个 key 本月（UTC，和 NodeReal 的重置时间一致）累计 CU 达到上限就只停用这个 key，改用其他 key / 公共节点，下月 1 号自动恢复。
// 启动时从 data/rpc-usage.jsonl（每分钟一行）把本月已用的算回来，所以重启不会清零。0 = 不限制
export const NODEREAL_MONTHLY_CU = Number(env('NODEREAL_MONTHLY_CU', '9000000'));
initNodeRealBudget({ limit: NODEREAL_URLS.length ? NODEREAL_MONTHLY_CU : 0, historyFile: pathJoin(DATA_DIR, 'rpc-usage.jsonl') });
// 读链 / 查确认 / 余额：有 NodeReal 就用它当主节点（多个 key 轮流），公共节点做备用（见 rpc.js）
export const RPC_URL = env('RPC_URL', NODEREAL_RPC || EP.rpcPublic[0] || '');
export const RPC_LIST = [...NODEREAL_URLS, RPC_URL, ...EP.rpcPublic.slice(0, 2)].filter((u, i, a) => u && a.indexOf(u) === i);
export const BAW_BIN = env('BAW_BIN', 'baw');
export const BINANCE_CHAIN_ID = Number(env('BINANCE_CHAIN_ID', 56));
export const BAW_SLIPPAGE_UNIT = env('BAW_SLIPPAGE_UNIT', 'percent'); // percent: 传 20 表示 20%；fraction: 传 0.2
export const WALLET_LABEL = env('WALLET_LABEL', '币安 Agentic 钱包');

export const BNB_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const EXPLORER = 'https://bscscan.com';

// Flap Agent Curve
export const READER = '0x18Aa6C93f1887a243fdc348C9A77F5136555174a';
export const PORTAL = '0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062';
export const FACTORY = '0xC55820f24015bE7c4f18949D9e1363A3609B300e';

export const QUOTE_TOKENS = {
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  BNCB: '0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f',
  NVDAB: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436',
  QQQB: '0x205812CdBed920aFf76C6580abD681a46D11efc7',
  SPCXB: '0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1',
};
export const QUOTE_BY_ADDRESS = Object.fromEntries(Object.entries(QUOTE_TOKENS).map(([k, v]) => [v.toLowerCase(), k]));

export const SHRINE_API = EP.shrine;
export const SHRINE_WS = EP.shrineWs ? `${EP.shrineWs}/api/launches/ws?protocols=FLAP,FOURMEME` : '';
export const SHRINE_STREAM = EP.shrineWs ? `${EP.shrineWs}/api/stream/ws?protocols=FLAP,FOURMEME&actions=buy,sell,create` : '';
export const FSI_BASE = EP.fsi;
export const BNB_PRICE_URL = EP.binance ? `${EP.binance}/api/v3/ticker/price?symbol=BNBUSDT` : '';

// Four 代币迁移（发射）后自动把整仓转到指定钱包
// 买入后自动「预授权」（无限额 approve）。默认关闭：无限额授权会被币安风控标成高风险，需要在 App 里确认并锁住钱包；卖出时会按本次数量授权
export const PREAPPROVE = env('PREAPPROVE', '0') === '1';
// 自动转出的目标地址：只从 .env 读，默认空。为空（或格式不对）时所有自动转出都不能打开
export const AUTO_TRANSFER_TO = /^0x[0-9a-fA-F]{40}$/.test(env('AUTO_TRANSFER_TO', '')) ? env('AUTO_TRANSFER_TO', '') : '';
// 默认关闭：自动把迁移后的 Four 持仓全部转走风险太大，确认地址是自己的再用 AUTO_TRANSFER_FOUR=1 打开
export const AUTO_TRANSFER_FOUR = env('AUTO_TRANSFER_FOUR', '0') === '1';
