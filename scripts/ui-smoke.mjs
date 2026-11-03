// 界面冒烟（交付前跑一遍）：每个页面打开一次，看有没有「出错了」、接口失败、主线程被占满；
// 筛选面板各开关两遍（面板里点一下不能被关掉）；NFT 标签能打开。
// 只做导航和开关面板，绝不点买卖 / 铸造 / 转出 / 确认按钮。
// 运行（先启动后端，默认 http://127.0.0.1:8788）：
//   ego-browser nodejs -e "$(cat scripts/ui-smoke.mjs)"
// 用别的地址：把下面的 BASE 改掉。失败会在最后抛错并列出原因。
const BASE = 'http://127.0.0.1:8788';
const task = await taskSpace('piupiu 界面冒烟');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };
const md = (sel) => `(() => { const el = ${sel}; if (!el) return 'no-el'; el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.click(); return 'ok' })()`;
try {
  const p = task.page('p1');
  await p.goto(BASE + '/'); await sleep(1500);
  await p.evaluate(() => localStorage.setItem('prefs-sync-off', '1'));   // 冒烟浏览器的设置不要上传到后端

  for (const r of ['/', '/trend', '/copy', '/snipe', '/radar', '/follow', '/portfolio', '/wallets']) {
    await p.goto(BASE + r); await sleep(3000);
    await p.evaluate(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration) }).observe({ type: 'longtask', buffered: true }) } catch {} });
    await sleep(6000);
    const blockedNow = () => p.evaluate(() => Math.round(window.__lt.reduce((a, b) => a + b, 0)));
    let blockedMin = await blockedNow();
    if (blockedMin >= 2500) { await p.evaluate(() => { window.__lt = []; }); await sleep(6000); blockedMin = Math.min(blockedMin, await blockedNow()); }   // 偶发的一次（比如刚重启后端 / 全量帧）复测一次，取小的
    const o = await p.evaluate(() => ({
      text: document.querySelector('main')?.innerText || '',
      blocked: Math.round(window.__lt.reduce((a, b) => a + b, 0)),
      failed: performance.getEntriesByType('resource').filter((e) => (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && e.responseStatus >= 400).map((e) => `${e.responseStatus} ${e.name.replace(location.origin, '').slice(0, 50)}`),
    }));
    check(!/出错了/.test(o.text), `${r} 没有「出错了」`);
    check(!/undefined|NaN/.test(o.text), `${r} 页面文字里没有 undefined / NaN`);
    check(o.failed.length === 0, `${r} 没有失败的接口请求${o.failed.length ? '：' + o.failed.join('，') : ''}`);
    check(blockedMin < 2500, `${r} 6 秒内主线程被占用 ${blockedMin}ms（预算 2500ms）`);
  }

  // 筛选面板：战壕列头 + 雷达列表，各开关两遍，面板里点一下不能被关掉，再点按钮能关
  const POP = [
    ['战壕筛选', '/', `document.querySelector('section .h-12 button.icon-btn.relative')`, `[...document.querySelectorAll('.pop.fixed button')][2]`],
    ['雷达筛选', '/radar', `[...document.querySelectorAll('button.icon-btn.relative')].find((b) => b.closest('.h-10'))`, `[...document.querySelectorAll('.pop.fixed .seg button')][1]`],
  ];
  for (const [name, route, btn, inner] of POP) {
    await p.goto(BASE + route); await sleep(4000);
    for (let i = 1; i <= 2; i++) {
      await p.evaluate(md(btn)); await sleep(2200);
      const opened = await p.evaluate(`!!document.querySelector('.pop.fixed')`);
      await p.evaluate(md(inner)); await sleep(400);
      const stay = await p.evaluate(`!!document.querySelector('.pop.fixed')`);
      await p.evaluate(md(btn)); await sleep(400);
      const closed = !(await p.evaluate(`!!document.querySelector('.pop.fixed')`));
      check(opened && stay && closed, `${name} 第 ${i} 次：能打开=${opened}，面板内点击后还在=${stay}，再点按钮能关=${closed}`);
    }
  }

  // 资产页 NFT 标签、顶部栏的 NFT 入口
  await p.goto(BASE + '/portfolio?tab=nft'); await sleep(3500);
  const nft = await p.evaluate(() => ({ tab: [...document.querySelectorAll('.tab')].find((b) => b.dataset.on === 'true')?.textContent || '', text: document.querySelector('main')?.innerText || '' }));
  check(/^NFT/.test(nft.tab), '资产页能直接打开 NFT 标签');
  // NFT 转出受币安限制时（shared/capabilities.js）只显示「暂不可用」，不显示地址输入和转出按钮；开放后显示转出地址设置
  check(/NFT 转出暂不可用/.test(nft.text) ? !/全部转出|设置转出地址/.test(nft.text) : /转出地址|转出到/.test(nft.text), 'NFT 标签：转出不可用时写明「暂不可用」且没有转出入口；可用时有转出地址设置');
  check(!/element/i.test(nft.text), 'NFT 标签里没有 Element 字样');

  // 设置弹窗：页签齐全；顶部栏左边的齿轮直接定位到「顶部栏」；自动化页有两个转出地址
  await p.goto(BASE + '/'); await sleep(3500);
  await p.evaluate(md(`document.querySelector('header button[title="设置"]')`)); await sleep(900);
  const tabs = await p.evaluate(() => { const t = document.body.innerText; return ['交易预设', '下单', '自动化与转出', '顶部栏', '授权管理', '已屏蔽与隐藏'].filter((x) => t.includes(x)); });
  check(tabs.length === 6, `设置页签齐全（看到 ${tabs.join(' / ')}）`);
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '自动化与转出')?.click()); await sleep(500);
  const auto = await p.evaluate(() => document.body.innerText);
  check(/NFT 转出地址/.test(auto) && /代币转出地址/.test(auto), '自动化与转出页有「NFT 转出地址」和「代币转出地址」两张卡片');
  await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await sleep(500);
  await p.goto(BASE + '/'); await sleep(3000);
  await p.evaluate(md(`document.querySelector('button[title="顶部栏设置"]')`)); await sleep(900);
  check(await p.evaluate(() => /快捷交易/.test(document.body.innerText) && /快捷买入金额|快捷卖出比例/.test(document.body.innerText)), '顶部栏左边的齿轮直接打开「顶部栏」设置');
  await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await sleep(400);

  // 底栏「自动化」汇总：能打开、列出开着的功能或明确写「没有开着」
  await p.goto(BASE + '/'); await sleep(3500);
  await p.evaluate(md(`[...document.querySelectorAll('footer button')].find((b) => /自动化/.test(b.textContent))`)); await sleep(900);
  check(await p.evaluate(() => /自动化/.test(document.querySelector('.pop.fixed')?.innerText || '') && /狙击/.test(document.querySelector('.pop.fixed')?.innerText || '') && /条件单/.test(document.querySelector('.pop.fixed')?.innerText || '')), '底栏「自动化」汇总能打开，且列出全部类别（含未开启的）');
  check(await p.evaluate(() => { const b = [...document.querySelectorAll('footer button')].find((x) => /自动化/.test(x.textContent)); return !!b && !b.querySelector('[class*="bg-warn"],[class*="bg-up"],[class*="bg-down"]') }), '底栏「自动化」按钮不带彩色徽标（和其他底栏按钮一样不亮）')
  check(await p.evaluate(() => { const pop = document.querySelector('.pop.fixed'); if (!pop) return false; const rows = pop.querySelectorAll('button').length; return (rows >= 3 && [...pop.querySelectorAll('button')].every((b) => b.textContent.trim() === '管理')) }), '「自动化」弹层里每一项都有「管理」按钮')
  await p.evaluate(md(`[...document.querySelectorAll('footer button')].find((b) => /自动化/.test(b.textContent))`)); await sleep(400);

  // 战壕：有卡片、没有左边的色条残留（押金卡片用整张渐变）
  await p.goto(BASE + '/'); await sleep(4000);
  const cards = await p.evaluate(() => ({ n: document.querySelectorAll('section .group').length, bar: [...document.querySelectorAll('section .group.bond-card')].some((c) => getComputedStyle(c, '::before').content !== 'none') }));
  check(cards.n > 0, `战壕有卡片（${cards.n}）`);
  check(!cards.bar, '押金卡片没有左侧色条');
} finally { await task.finish({ keep: [] }); }
if (fails.length) throw new Error(`界面冒烟失败 ${fails.length} 项：\n- ${fails.join('\n- ')}`);
console.log('界面冒烟全部通过');
