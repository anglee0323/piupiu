// 刷新内核自带的 .ai 钱包名单（engine/live/radar/ai-seed.txt）。
// 为什么要自带：Agent ID 合约不能枚举持有人，雷达只能在扫块时懒判断（每分钟最多查 30 个地址），
// 新装的电脑要积累好几天才认得出「.ai 钱包在铸造」，期间雷达一个项目都没有（2026-11-02 Windows 实测）。
// 名单是公开链上数据（谁持有 Agent ID NFT），从本机雷达缓存 + 名字缓存导出，与已有名单合并。发内核前跑一次。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DATA_DIR } from '../engine/live/config.js';
import { join } from 'node:path';

const OUT = new URL('../engine/live/radar/ai-seed.txt', import.meta.url);
const set = new Set();
const add = (a) => { const k = String(a || '').toLowerCase().replace(/^0x/, ''); if (/^[0-9a-f]{40}$/.test(k)) set.add(k); };
if (existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').split('\n')) add(l.trim());
const before = set.size;
const cache = join(DATA_DIR, 'radar', 'ai-cache.json');
if (existsSync(cache)) for (const [a, v] of Object.entries(JSON.parse(readFileSync(cache, 'utf8')))) if (v === true || (v && (v.ai || typeof v === 'string'))) add(a);
const names = join(DATA_DIR, 'names.json');
if (existsSync(names)) {
  const j = JSON.parse(readFileSync(names, 'utf8'));
  for (const [a, v] of Object.entries(j.names || j)) { const n = typeof v === 'string' ? v : v?.name; if (String(n || '').endsWith('.ai')) add(a); }
}
// 不带本机自己的钱包（名单是公开数据，但没必要把作者的钱包放进安装包）
const wf = join(DATA_DIR, 'wallets.json');
if (existsSync(wf)) for (const s of JSON.parse(readFileSync(wf, 'utf8')).slots || []) if (s.pinned) set.delete(String(s.pinned).toLowerCase().replace(/^0x/, ''));
writeFileSync(OUT, [...set].sort().join('\n') + '\n');
console.log(`.ai 钱包名单：${set.size} 个（新增 ${set.size - before}）`);
