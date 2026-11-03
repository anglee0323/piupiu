// 跨平台的环境变量启动器：npm 脚本里 `MODE=live node server.js` 这种写法是 Unix shell 语法，Windows 的 cmd 不支持。
// 用法：node scripts/with-mode.mjs KEY=VALUE KEY=VALUE …（值以 ~/ 开头时展开为用户主目录，兼容 Windows 路径）
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';

for (const a of process.argv.slice(2)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(a);
  if (!m) { console.error(`无法解析参数「${a}」，应写成 KEY=VALUE`); process.exit(1); }
  let v = m[2];
  if (v.startsWith('~/')) v = pathJoin(homedir(), v.slice(2));
  process.env[m[1]] = v;
}

await import(new URL('../server.js', import.meta.url));
