// 钱包槽位注册表（多钱包方案 P0，docs/PLAN-MULTI-WALLET.md §4.1）：
// 一个后端进程里管理 N 个钱包。每个槽位 = baw 的一个登录凭证空间：
//   槽位 1（W1）：baw 默认位置（不走钩子），老用户的登录不受影响；
//   槽位 N（W2…）：钥匙串 service baw.piupiu.w<N> + 独立会话目录 ~/.piupiu/wallets/w<N>/baw（仓库外，绝对路径）。
// 数据存 data/wallets.json；pinned = 登录锁定的地址（防止这个槽位后来扫成别的账号）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataFile, APP_MODE, APP_HOME } from './config.js';

const FILE = dataFile('wallets.json');
export const MAX_SLOTS = 8;

const read = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; } };
const write = (d) => { mkdirSync(new URL('.', FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(d, null, 1)); };

const norm = (d) => {
  d.slots = (Array.isArray(d.slots) ? d.slots : []).filter((s) => Number.isInteger(s.slot) && s.slot > 0);
  d.slots.sort((a, b) => (a.order ?? a.slot) - (b.order ?? b.slot));
  if (!d.slots.length) d.slots = [{ slot: 1, label: null, pinned: null, addedAt: Date.now(), order: 0 }];   // 首次：自动建 W1
  // nextSlot 要在插入默认 W1 之后算（空表时先算会得到 1，add() 会复用槽位 1）
  d.nextSlot = Math.max(1, Number(d.nextSlot) || 1, ...d.slots.map((s) => s.slot + 1));
  if (!d.slots.some((s) => s.slot === d.primary)) d.primary = d.slots[0].slot;
  return d;
};

let data = null;
const load = () => (data ||= norm(read() || { primary: 1, nextSlot: 1, slots: [] }));
const save = () => write(load());

// 槽位 → baw profile 名（null = W1 走默认位置）。
// 安装版（PIUPIU_APP=1）里 W1 也走钩子：每个钱包的会话目录和登录凭证都在 App 自己的用户目录里，
// 凭证存成只有当前系统用户能读写的文件，不读写系统钥匙串（macOS 上跨程序读钥匙串会对每个 baw 进程弹授权框），
// 也不碰这台电脑原有的 ~/.baw（用户自己的 baw / AI Agent 登录互不影响）
export const profileOf = (slot) => (Number(slot) === 1 && !APP_MODE ? null : `w${Number(slot)}`);

// 每个槽位自己的 baw 会话目录（绝对路径，放在仓库和 data/ 之外）
export const bawDirOf = (slot) => { const p = profileOf(slot); return p ? (APP_MODE ? pathJoin(APP_HOME, 'wallets', p, 'baw') : pathJoin(homedir(), '.piupiu', 'wallets', p, 'baw')) : null; };

// 调 baw 子进程时要带的额外环境变量（W1 返回空对象 = 沿用本进程默认）
export const bawEnvOf = (slot) => {
  const p = profileOf(slot);
  if (!p) return {};
  const env = { PIUPIU_BAW_PROFILE: p, BINANCE_BAW_DIR: bawDirOf(slot), BINANCE_INSTANCE_ID: `piupiu-${p}` };
  if (APP_MODE) env.PIUPIU_KEYSTORE_FILE = pathJoin(bawDirOf(slot), 'piupiu-credential.json');   // 登录凭证存文件（baw-profile/keytar-ns.mjs）；和会话目录一起，移除钱包时一起删
  return env;
};

export function list() { return load().slots.map((s) => ({ ...s })); }
export function get(slot) { return load().slots.find((s) => s.slot === Number(slot)) || null; }
export function primary() { return load().primary; }

export function add() {
  const d = load();
  if (d.slots.length >= MAX_SLOTS) throw new Error(`最多 ${MAX_SLOTS} 个钱包`);
  const slot = d.nextSlot;
  d.slots.push({ slot, label: null, pinned: null, addedAt: Date.now(), order: d.slots.length });
  d.nextSlot = slot + 1;
  save();
  return get(slot);
}

export function pin(slot, address) {
  const d = load(); const s = d.slots.find((x) => x.slot === Number(slot));
  if (!s || !/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) return;
  s.pinned = String(address).toLowerCase(); save();
}

export function update(slot, patch = {}) {
  const d = load(); const s = d.slots.find((x) => x.slot === Number(slot));
  if (!s) throw new Error('没有这个钱包槽位');
  if (patch.label !== undefined) { const v = String(patch.label || '').trim().slice(0, 40); s.label = v || null; }
  if (patch.order !== undefined) s.order = Number(patch.order) || 0;
  save();
  if (patch.primary === true) setPrimary(slot);
  return { ...s };
}

export function setPrimary(slot) {
  const d = load();
  if (!d.slots.some((x) => x.slot === Number(slot))) throw new Error('没有这个钱包槽位');
  d.primary = Number(slot); save();
}

// 移除槽位：清掉它的会话目录（钥匙串条目由 baw auth signout 删）。返回被移除的槽位
export function remove(slot) {
  const d = load(); slot = Number(slot);
  const i = d.slots.findIndex((x) => x.slot === slot);
  if (i < 0) throw new Error('没有这个钱包槽位');
  if (d.slots.length === 1) throw new Error('至少保留一个钱包');
  const [s] = d.slots.splice(i, 1);
  const dir = bawDirOf(slot);
  if (dir && existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就留着，不影响 */ } }
  d.primary = d.slots.some((x) => x.slot === d.primary) ? d.primary : d.slots[0].slot;
  save();
  return s;
}

export function byAddress(address) {
  const a = String(address || '').toLowerCase();
  return a ? load().slots.find((s) => s.pinned === a) || null : null;
}

// 供测试重置
export const _reset = () => { data = null; };
export const _file = () => fileURLToPath(FILE);
