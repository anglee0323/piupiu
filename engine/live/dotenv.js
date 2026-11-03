// 最先加载的模块：判断安装版模式、确定用户目录，并把 .env 读进环境变量。
// 单独成一个文件，是因为 endpoints.js（开源版从环境变量读数据源地址）、rpc.js 都在 config.js 之前求值，必须先有 .env。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';

// 安装版（App）模式：由安装包的启动器设置 PIUPIU_APP=1（必须是真实环境变量，不能写在 .env 里）。
// 这时数据、备份、.env 全部放在系统的用户目录（APP_HOME），不读项目文件夹里的任何东西——
// 开发机上项目里的 data/ 和 .env 是作者自己的钱包记录和私有 Key，绝不能被安装版读到或带进安装包。
//   macOS：~/Library/Application Support/Piupiu    Windows：%APPDATA%\Piupiu    其他：$XDG_CONFIG_HOME/piupiu 或 ~/.config/piupiu
// PIUPIU_HOME 可以手动指定（测试或便携版用）
export const APP_MODE = process.env.PIUPIU_APP === '1';
function defaultAppHome() {
  if (process.platform === 'darwin') return pathJoin(homedir(), 'Library', 'Application Support', 'Piupiu');
  if (process.platform === 'win32') return pathJoin(process.env.APPDATA || pathJoin(homedir(), 'AppData', 'Roaming'), 'Piupiu');
  return pathJoin(process.env.XDG_CONFIG_HOME || pathJoin(homedir(), '.config'), 'piupiu');
}
export const APP_HOME = APP_MODE ? pathResolve(process.env.PIUPIU_HOME || defaultAppHome()) : null;
// 启动时读 .env（KEY=VALUE，# 开头是注释）；已经在环境变量里的不覆盖。开发时读项目根目录的（在 .gitignore 里），安装版读 APP_HOME 里的（可选，高级用户自己放）
try {
  for (const line of readFileSync(APP_MODE ? pathJoin(APP_HOME, '.env') : new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* 没有 .env 就算了 */ }
