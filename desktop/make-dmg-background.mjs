// 生成 macOS 安装窗口（dmg）的背景图：node desktop/make-dmg-background.mjs
// 安装包未签名，首次打开会被系统拦截，所以在窗口底部写明放行方法。输出 resources/dmg-background.png 与 @2x。
// 用 cloud/node_modules 里的 playwright-core + 本机 Chromium 渲染。
import { chromium } from '../cloud/node_modules/playwright-core/index.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./resources/', import.meta.url));
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const exe = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()
  .map((d) => `${cache}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync);
if (!exe) throw new Error('找不到本机 Chromium（~/Library/Caches/ms-playwright）');

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0 }
  body { width: 540px; height: 380px; background: #f4f2ec; color: #1b1b1a; position: relative; overflow: hidden;
    font-family: -apple-system, "SF Pro Text", "PingFang SC", sans-serif; }
  .t { position: absolute; top: 40px; left: 0; right: 0; text-align: center; }
  .t b { display: block; font-size: 17px; font-weight: 650; }
  .t span { display: block; margin-top: 5px; font-size: 12.5px; color: #7b7870; }
  svg { position: absolute; left: 0; top: 0 }
  .h { position: absolute; left: 28px; right: 28px; bottom: 22px; padding: 11px 14px; border-radius: 10px; background: #fdfcf9; border: 1px solid #e2ded3;
    font-size: 11.5px; line-height: 1.6; color: #45443f; }
  .h b { font-weight: 650; color: #1b1b1a }
  .h em { font-style: normal; font-weight: 650; background: #f6d86b; padding: 0 4px; border-radius: 3px; color: #1b1b1a }
  .h div + div { margin-top: 2px; color: #7b7870 }
</style>
<div class="t"><b>将 Piupiu 拖入「应用程序」</b><span>Drag Piupiu to Applications</span></div>
<svg width="540" height="380"><path d="M214 190h112M312 178l14 12-14 12" fill="none" stroke="#b9b3a3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="h"><div><b>首次打开被系统拦截？</b>前往「系统设置 → 隐私与安全性」，点<em>仍要打开</em></div>
<div>If macOS blocks it: System Settings → Privacy &amp; Security → <b>Open Anyway</b></div></div>`;

const b = await chromium.launch({ executablePath: exe });
for (const [scale, name] of [[1, 'dmg-background.png'], [2, 'dmg-background@2x.png']]) {
  const p = await b.newPage({ viewport: { width: 540, height: 380 }, deviceScaleFactor: scale });
  await p.setContent(html); await p.screenshot({ path: OUT + name }); await p.close();
}
await b.close();
console.log('已生成', OUT);
