// 系统代理：币安钱包命令行（baw）是独立的 Node 进程，不会像浏览器那样自动走系统代理。
// 用户用「系统代理」模式的代理软件时（不是增强模式 / TUN），baw 直连 binance.com 会超时。
// 这里读出系统代理，交给 baw 的环境变量（Node 24 的 NODE_USE_ENV_PROXY=1 让 fetch 认 HTTPS_PROXY）。
// 只支持 HTTP / HTTPS 代理（代理软件的「混合端口」两种都支持）；SOCKS 与 PAC 脚本无法使用，需要用户开增强模式。
// 手动指定：环境变量 PIUPIU_PROXY=http://127.0.0.1:7890；设为 off 则一律直连。
import { execFileSync } from 'node:child_process';

const LOCAL = 'localhost,127.0.0.1,::1';
let cache = null;

function run(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
}
const asUrl = (hostPort) => {
  const s = String(hostPort || '').trim();
  if (!s) return null;
  return /^[a-z]+:\/\//i.test(s) ? s : `http://${s}`;
}

/** macOS：scutil --proxy 的 HTTPS（没有就用 HTTP）代理 */
export function parseScutil(text) {
  const get = (k) => new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim();
  for (const p of ['HTTPS', 'HTTP']) {
    if (get(`${p}Enable`) === '1' && get(`${p}Proxy`) && get(`${p}Port`)) return asUrl(`${get(`${p}Proxy`)}:${get(`${p}Port`)}`);
  }
  return null;
}
/** Windows：注册表的 ProxyEnable / ProxyServer（「host:port」或「http=host:port;https=host:port;socks=…」） */
export function parseWinProxy(enableOut, serverOut) {
  if (!/0x1\b/.test(enableOut || '')) return null;
  const raw = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(serverOut || '')?.[1]?.trim();
  if (!raw) return null;
  if (!raw.includes('=')) return asUrl(raw);
  const map = Object.fromEntries(raw.split(';').map((x) => x.split('=')).filter((x) => x.length === 2));
  return map.https ? asUrl(map.https) : map.http ? asUrl(map.http) : null;
}

function detect() {
  const manual = process.env.PIUPIU_PROXY;
  if (manual) return /^(off|none|direct)$/i.test(manual) ? null : asUrl(manual);
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return asUrl(envProxy);
  if (process.platform === 'darwin') return parseScutil(run('/usr/sbin/scutil', ['--proxy']));
  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    return parseWinProxy(run('reg', ['query', key, '/v', 'ProxyEnable']), run('reg', ['query', key, '/v', 'ProxyServer']));
  }
  return null;
}

/** 当前要用的代理（缓存 30 秒：用户开关代理软件后很快生效），没有则 null */
export function currentProxy() {
  if (cache && Date.now() - cache.at < 30_000) return cache.url;
  let url = null;
  try { url = detect(); } catch { /* 读不到就当没有 */ }
  if (url && url !== cache?.url) console.log(`[proxy] baw 使用代理 ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  cache = { url, at: Date.now() };
  return url;
}

/** 给子进程的环境变量加上代理设置；没有代理时原样返回 */
export function withProxyEnv(env) {
  const url = currentProxy();
  if (!url || /^socks/i.test(url)) return env;
  return { ...env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: [env.NO_PROXY, LOCAL].filter(Boolean).join(',') };
}
