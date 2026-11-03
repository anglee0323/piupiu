// 冒烟自检（CI / 换平台时用）：以模拟盘启动 server.js，轮询 /api/state 直到有响应。
// 用法：node scripts/smoke.mjs [KEY=VALUE …]（默认 MODE=sim PORT=8799；不连钱包、不下单）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join as pathJoin } from 'node:path';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const env = { ...process.env };
for (const a of process.argv.slice(2)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(a);
  if (m) env[m[1]] = m[2];
}
env.MODE = env.MODE || 'sim';
env.PORT = env.PORT || '8799';
const port = env.PORT;

const child = spawn(process.execPath, [pathJoin(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
const note = (buf) => { tail = (tail + String(buf)).split('\n').slice(-25).join('\n'); };
child.stdout.on('data', note); child.stderr.on('data', note);

const deadline = Date.now() + 120_000;
(async () => {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const j = await r.json();
        console.log(`冒烟通过：/api/state 200（tokens ${j.tokens?.length ?? '?'}，orders ${j.orders?.length ?? 0}）`);
        child.kill();
        process.exit(0);
      }
    } catch { /* 还没起来，继续等 */ }
    if (child.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`冒烟失败：服务没有在 120 秒内响应 http://127.0.0.1:${port}/api/state（exitCode=${child.exitCode}）\n最后的输出：\n${tail}`);
  child.kill();
  process.exit(1);
})();
