// 每日备份：把 data/ 里不可再生的文件（订单、持仓、铸造历史、关注、设置、追踪、规则…）打成 tar.gz，放到 backups/（已在 .gitignore），保留最近 N 天。
// 不备份：img/（图片缓存）、radar/social/ 和 radar/src/（可重新抓取的缓存）、rpc-usage.jsonl、日志、api-token（本机访问令牌，不暂存凭据）。
// 用系统自带的 tar（macOS / Linux / Windows 10+ 都有）。每天一份：启动后 1 分钟检查一次，之后每 6 小时检查，今天已有就跳过。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const EXCLUDES = ['./img', './api-token', './radar/social', './radar/src', './rpc-usage.jsonl', './server-runtime.log', './wallet-events.log', './*.tmp', './*.log'];
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const NAME = /^piupiu-data-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;

export const listBackups = (outDir) => { try { return readdirSync(outDir).filter((f) => NAME.test(f)).sort().reverse(); } catch { return []; } };

/** 生成今天的备份（已有就返回 null）。返回文件路径 */
export function backupOnce({ dataDir, outDir, keep = 14, now = new Date(), log = () => {} } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(dataDir)) return resolve(null);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    try { chmodSync(outDir, 0o700); } catch { /* Windows 没有 */ }
    const file = join(outDir, `piupiu-data-${day(now)}.tar.gz`);
    if (existsSync(file)) return resolve(null);
    const tmp = file + '.tmp';
    const args = ['-czf', tmp, ...EXCLUDES.flatMap((e) => ['--exclude', e]), '-C', dataDir, '.'];
    execFile('tar', args, { timeout: 120_000 }, async (err) => {
      if (err) { log(`[备份] 失败：${String(err.message).slice(0, 160)}`); try { unlinkSync(tmp); } catch { /* 没生成 */ } return resolve(null); }
      try {
        const { renameSync } = await import('node:fs');
        renameSync(tmp, file);
        const old = listBackups(outDir).slice(keep);
        for (const f of old) { try { unlinkSync(join(outDir, f)); } catch { /* ignore */ } }
        log(`[备份] 已生成 ${file}（${(statSync(file).size / 1024).toFixed(0)} KB，保留最近 ${keep} 份${old.length ? `，清掉 ${old.length} 份旧的` : ''}）`);
      } catch (e) { log(`[备份] 收尾失败：${e.message}`); return resolve(null); }
      resolve(file);
    });
  });
}

export function startBackups(opts) {
  const run = () => backupOnce(opts).catch((e) => (opts.log || (() => {}))(`[备份] 出错：${e.message}`));
  const t1 = setTimeout(run, 60_000), t2 = setInterval(run, 6 * 3600_000);
  t1.unref?.(); t2.unref?.();
  return () => { clearTimeout(t1); clearInterval(t2); };
}
