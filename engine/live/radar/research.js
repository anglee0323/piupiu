// 资料（方案 R3）：有界读取项目链接——只走 https、只连公网域名、单页 ≤ 600KB、8 秒超时、不执行脚本只当文本。
// 读官网标题 / 描述，再试 llms.txt、skill.md、agents.md 这类「给 Agent 看的说明」（EZbot discovery 的规则，MIT）。
// 外部文字只当线索展示：不会触发任何交易，也不改任何设置。x.com / t.me 要登录才能看，只记链接不抓。
const MAX = 600_000;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1|\[?f[cd])/i;
const NOFETCH = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|discord\.(gg|com)|medium\.com)$/i;

export function safeUrl(u) {
  try {
    const x = new URL(String(u).trim());
    if (x.protocol !== 'https:') return null;
    if (PRIVATE.test(x.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(x.hostname) || !x.hostname.includes('.')) return null;
    return x;
  } catch { return null; }
}

async function getText(url, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Piupiu radar; read-only)', accept: 'text/html,text/plain,text/markdown,*/*;q=0.5' } });
    if (!r.ok) return { status: r.status };
    const final = safeUrl(r.url); if (!final) return { status: 0, error: '跳转到了不安全的地址' };
    const reader = r.body?.getReader(); if (!reader) return { status: r.status, text: '' };
    let got = 0; const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; chunks.push(value); if (got > MAX) { ac.abort(); break; } }
    return { status: r.status, type: r.headers.get('content-type') || '', text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8').slice(0, MAX) };
  } catch (e) { return { status: 0, error: e.name === 'AbortError' ? '超时' : e.message }; }
  finally { clearTimeout(t); }
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const meta = (html, re) => decode((re.exec(html) || [])[1] || '').trim();
const visibleText = (html) => decode(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** 读一个链接：网页给标题 / 描述 / 正文开头；纯文本（llms.txt 等）给开头 */
export async function readLink(u) {
  const x = safeUrl(u); if (!x) return { url: String(u), ok: false, error: '只读取 https 公网链接' };
  if (NOFETCH.test(x.hostname)) return { url: x.href, ok: false, social: true, error: '社交平台需要登录，只记录链接' };
  const r = await getText(x.href);
  if (!r.text) return { url: x.href, ok: false, error: r.error || `打不开（${r.status}）` };
  if (/html/i.test(r.type) || /<html/i.test(r.text.slice(0, 500))) {
    const title = meta(r.text, /<title[^>]*>([^<]{1,200})/i);
    const desc = meta(r.text, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,600})/i) || meta(r.text, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,600})/i);
    const body = visibleText(r.text).slice(0, 1200);
    const links = [...new Set((r.text.match(/https:\/\/(x\.com|twitter\.com|t\.me|discord\.gg)\/[A-Za-z0-9_/-]+/g) || []))].slice(0, 6);
    return { url: x.href, ok: true, kind: 'page', title, desc, text: body, links };
  }
  return { url: x.href, ok: true, kind: 'text', text: r.text.replace(/\s+/g, ' ').slice(0, 2000) };
}

/** 官网之外再试「给 Agent 看的说明」文件 */
export async function readSite(u) {
  const x = safeUrl(u); if (!x) return [];
  const out = [await readLink(x.href)];
  if (NOFETCH.test(x.hostname)) return out;
  for (const p of ['/llms.txt', '/skill.md', '/SKILL.md', '/agents.md']) {
    const r = await readLink(x.origin + p);
    if (r.ok && r.kind === 'text' && r.text.length > 40 && !/<html/i.test(r.text)) { out.push({ ...r, guide: true }); break; }
  }
  return out;
}
